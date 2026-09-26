/**
 * GitHub App webhook ingress — framework-agnostic, mounted unauthenticated
 * (by OAuth) in streamable-http.ts at /hosts/github/events. Authenticated by
 * the App's webhook secret (X-Hub-Signature-256) over the raw body.
 * Nothing from the body is logged.
 */
import { Prisma, type PrismaClient } from "#prisma";
import type { HostEventDb } from "../../core/host-events.js";
import { routeHostEvent } from "../../core/host-events.js";
import { logger } from "../../core/logger.js";
import type { Executor } from "../../providers/executor/types.js";
import { normalizeGitHubEvent, verifyGitHubSignature } from "../../providers/review-host/github-events.js";
import type { ReviewHostRegistry } from "../../providers/review-host/types.js";

const log = logger.child({ module: "github-ingress" });
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const SAFE_DELIVERY = /^[A-Za-z0-9-]{1,100}$/;
let lastPruneAt = 0;

export interface GitHubIngressDeps {
  db: HostEventDb & Pick<PrismaClient, "hostEventDelivery">;
  executor: Executor;
  hosts: ReviewHostRegistry;
  webhookSecret: string | undefined;
  appIdentity: () => Promise<{ id: number; slug: string }>;
  now?: () => Date;
}

export interface GitHubIngressResult {
  status: number;
  body: Record<string, unknown>;
  /** Cosmetic follow-ups (reactions) to run after the response is sent. */
  afterResponse?: () => Promise<void>;
}

export async function handleGitHubEventIngress(
  req: { headers: Record<string, string | undefined>; rawBody: string },
  deps: GitHubIngressDeps,
): Promise<GitHubIngressResult> {
  if (!deps.webhookSecret) return { status: 404, body: { error: "not_found" } };
  if (!verifyGitHubSignature(req.rawBody, req.headers["x-hub-signature-256"], deps.webhookSecret)) {
    return { status: 401, body: { error: "invalid_signature" } };
  }
  const deliveryId = req.headers["x-github-delivery"];
  const eventName = req.headers["x-github-event"];
  if (!deliveryId || !SAFE_DELIVERY.test(deliveryId) || !eventName) {
    return { status: 400, body: { error: "missing_delivery_headers" } };
  }

  const now = (deps.now ?? (() => new Date()))();

  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const app = await deps.appIdentity();
  const event = normalizeGitHubEvent(eventName, payload, app);
  // An event we don't act on must never claim the delivery id: recording it
  // here would let a later, real delivery of the same id (GitHub does reuse
  // ids across distinct redeliveries of what it considers the same event)
  // be silently swallowed as a "duplicate" of something we never routed.
  if (!event) return { status: 202, body: { ignored: true } };

  try {
    await deps.db.hostEventDelivery.create({ data: { provider: "github", deliveryId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { status: 202, body: { duplicate: true } };
    }
    throw err;
  }
  if (now.getTime() - lastPruneAt > PRUNE_INTERVAL_MS) {
    lastPruneAt = now.getTime();
    await deps.db.hostEventDelivery
      .deleteMany({ where: { receivedAt: { lt: new Date(now.getTime() - DELIVERY_RETENTION_MS) } } })
      .catch((err: unknown) => log.warn({ err }, "delivery prune failed"));
  }

  // The delivery row is recorded before routing so a duplicate can never
  // race past it, but that means a transient failure inside routeHostEvent
  // must not leave a delivery permanently marked "done" — GitHub's redelivery
  // would then hit our P2002 dedup check and the event would be lost for
  // good. On failure here, un-record the delivery and rethrow so the retry
  // (ours or GitHub's redelivery) is routed for real, not reported duplicate.
  try {
    const routed = await routeHostEvent(event, {
      db: deps.db,
      executor: deps.executor,
      hosts: deps.hosts,
      mentionHandle: app.slug,
    });
    log.info({ event: event.kind, repository: event.repository, deliveryId, runIds: routed.runIds }, "host event routed");
    return {
      status: 202,
      body: { runIds: routed.runIds },
      afterResponse: async () => {
        for (const followUp of routed.followUps) await followUp();
      },
    };
  } catch (err) {
    await deps.db.hostEventDelivery
      .deleteMany({ where: { provider: "github", deliveryId } })
      .catch((delErr: unknown) => log.warn({ err: delErr }, "could not roll back the delivery record after a routing failure"));
    throw err;
  }
}

/** Test-only: reset the prune clock. */
export function resetPruneClockForTests(): void {
  lastPruneAt = 0;
}
