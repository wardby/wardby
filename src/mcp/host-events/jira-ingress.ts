/**
 * Jira Cloud webhook ingress — framework-agnostic, mounted unauthenticated
 * (by OAuth) in streamable-http.ts at /hosts/jira/events. Authenticated by the
 * webhook secret (X-Hub-Signature, WebSub style) over the raw body. The
 * delivery id (X-Atlassian-Webhook-Identifier) is stable across Jira's
 * retries, so it is the dedupe key. Nothing from the body is logged.
 */
import { Prisma, type PrismaClient } from "#prisma";
import { maybePruneHostEventDeliveries } from "./deliveries.js";
import { routeIssueEvent, type IssueEventDb } from "../../core/issue-events.js";
import { logger } from "../../core/logger.js";
import type { Executor } from "../../providers/executor/types.js";
import type { SecretCipher } from "../../core/plans/publish.js";
import { normalizeJiraEvent, verifyJiraSignature } from "../../providers/issue-tracker/jira-events.js";
import type { IssueTrackerRegistry } from "../../providers/issue-tracker/types.js";

const log = logger.child({ module: "jira-ingress" });
const SAFE_DELIVERY = /^[A-Za-z0-9._:-]{1,200}$/;

export interface JiraIngressDeps {
  db: IssueEventDb & Pick<PrismaClient, "hostEventDelivery">;
  executor: Executor;
  trackers: IssueTrackerRegistry;
  /** Reads a builder's secret values to redact its approved plan (spec §7). */
  secretCipher?: SecretCipher;
  webhookSecret: string;
  /** Epoch-ms clock; injected by tests. */
  now?: () => number;
}

/** Jira retries a delivery up to 5 times, 5-15 min apart, so 2 h comfortably covers a legitimate replay. */
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

/**
 * Whether the payload's top-level `timestamp` is inside the replay window.
 * Assumed to be epoch milliseconds; a value below 1e12 (before 2001 in ms)
 * is read as seconds. The unit is unverified against a live delivery.
 * A missing or non-numeric timestamp is not fresh.
 */
function isFresh(payload: unknown, nowMs: number): boolean {
  const raw = (payload as { timestamp?: unknown } | null)?.timestamp;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return false;
  const ts = raw < 1e12 ? raw * 1000 : raw;
  return ts >= nowMs - MAX_AGE_MS && ts <= nowMs + MAX_FUTURE_MS;
}

export interface JiraIngressResult {
  status: number;
  body: Record<string, unknown>;
  /** Cosmetic follow-ups to run after the response is sent. */
  afterResponse?: () => Promise<void>;
}

export async function handleJiraEventIngress(
  req: { headers: Record<string, string | undefined>; rawBody: string },
  deps: JiraIngressDeps,
): Promise<JiraIngressResult> {
  const tracker = deps.trackers.jira;
  if (!tracker) return { status: 404, body: { error: "not_found" } };
  if (!verifyJiraSignature(req.rawBody, req.headers["x-hub-signature"], deps.webhookSecret)) {
    return { status: 401, body: { error: "invalid_signature" } };
  }
  // wardby must not act as a person. A lookup failure throws (5xx), so Jira retries the delivery.
  const identity = await tracker.identity();
  if (identity.accountType === "atlassian") {
    log.error("Jira token belongs to a person; refusing deliveries (use a service account)");
    return { status: 503, body: { error: "jira_personal_account" } };
  }
  const deliveryId = req.headers["x-atlassian-webhook-identifier"];
  if (!deliveryId || !SAFE_DELIVERY.test(deliveryId)) {
    return { status: 400, body: { error: "missing_delivery_headers" } };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  // Replay protection: the signature covers the body, so an old captured delivery would otherwise verify forever.
  if (!isFresh(payload, (deps.now ?? Date.now)())) return { status: 202, body: { ignored: "stale" } };
  const event = normalizeJiraEvent(payload, identity.accountId);
  // An event we don't act on must never claim the delivery id (see the GitHub ingress).
  if (!event) return { status: 202, body: { ignored: true } };

  try {
    await deps.db.hostEventDelivery.create({ data: { provider: "jira", deliveryId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { status: 202, body: { duplicate: true } };
    }
    throw err;
  }
  await maybePruneHostEventDeliveries(deps.db, new Date());

  // A routing failure must not leave the delivery permanently marked done:
  // un-record it and rethrow so Jira's retry is routed for real.
  try {
    const routed = await routeIssueEvent(event, {
      db: deps.db,
      executor: deps.executor,
      trackers: deps.trackers,
      ...(deps.secretCipher ? { secretCipher: deps.secretCipher } : {}),
    });
    log.info({ kinds: event.kinds, deliveryId, runIds: routed.runIds }, "jira event routed");
    return {
      status: 202,
      body: { runIds: routed.runIds },
      afterResponse: async () => {
        for (const followUp of routed.followUps) await followUp();
      },
    };
  } catch (err) {
    await deps.db.hostEventDelivery
      .deleteMany({ where: { provider: "jira", deliveryId } })
      .catch((delErr: unknown) =>
        log.warn({ err: delErr }, "could not roll back the delivery record after a routing failure"),
      );
    throw err;
  }
}
