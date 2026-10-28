/**
 * GitHub App webhook ingress — framework-agnostic, mounted unauthenticated
 * (by OAuth) in streamable-http.ts at /hosts/github/events. Authenticated by
 * the App's webhook secret (X-Hub-Signature-256) over the raw body.
 * Nothing from the body is logged.
 */
import { Prisma, type PrismaClient } from "#prisma";
import { maybePruneHostEventDeliveries } from "./deliveries.js";
import type { HostEventDb } from "../../core/host-events.js";
import { routeHostEvent } from "../../core/host-events.js";
import { logger } from "../../core/logger.js";
import type { Executor } from "../../providers/executor/types.js";
import { normalizeGitHubEvent, verifyGitHubSignature } from "../../providers/review-host/github-events.js";
import type { IssueTrackerRegistry } from "../../providers/issue-tracker/types.js";
import type { ReviewHostRegistry } from "../../providers/review-host/types.js";
import type { RepoAccessGate } from "../../core/repo-access.js";
import { isGitHubAccountAllowed, trustedAccounts } from "../../config/github-allowed-accounts.js";

const log = logger.child({ module: "github-ingress" });
const SAFE_DELIVERY = /^[A-Za-z0-9-]{1,100}$/;

export interface GitHubIngressDeps {
  db: HostEventDb & Pick<PrismaClient, "hostEventDelivery">;
  executor: Executor;
  hosts: ReviewHostRegistry;
  /** Repository authorization for every dispatch, and the mention author's permission. */
  repoAccess: RepoAccessGate;
  /** For a merged/closed PR's linked issue; absent → closed PRs are ignored. */
  issueTrackers?: IssueTrackerRegistry;
  webhookSecret: string | undefined;
  /**
   * The App's id, slug, and owner (the owner is always served). Throwing fails
   * the request closed. `fresh` bypasses any cache; it is used before an
   * uninstall, since the owner can change while the server runs.
   */
  appIdentity: (opts?: { fresh?: boolean }) => Promise<{ id: number; slug: string; ownerLogin: string }>;
  /** Accounts served in addition to the App's owner (WARDBY_GITHUB_ALLOWED_ACCOUNTS). */
  allowedAccounts: () => ReadonlySet<string>;
  /** False = no reply explaining why a mention started nothing (WARDBY_MENTION_EXPLANATIONS). */
  mentionExplanations?: boolean;
  /** Removes the App from an installation on an account that isn't served; absent = ignore only. */
  uninstallInstallation?: (installationId: number) => Promise<void>;
  now?: () => Date;
}

export interface GitHubIngressResult {
  status: number;
  body: Record<string, unknown>;
  /** Cosmetic follow-ups (reactions) to run after the response is sent. */
  afterResponse?: () => Promise<void>;
}

const INSTALLATION_EVENTS = new Set(["installation", "installation_repositories"]);

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * Which GitHub account an event belongs to. Installation events name it on
 * the installation; repository events carry only installation.id, so the
 * repository's owner stands in.
 */
export function eventAccount(
  eventName: string,
  payload: unknown,
): { login: string; installationId?: number; uninstall: boolean } | undefined {
  if (INSTALLATION_EVENTS.has(eventName)) {
    const installation = field(payload, "installation");
    const login = field(field(installation, "account"), "login");
    const id = field(installation, "id");
    if (typeof login !== "string" || login === "") return undefined;
    return {
      login,
      ...(typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? { installationId: id } : {}),
      uninstall: field(payload, "action") !== "deleted",
    };
  }
  const repository = field(payload, "repository");
  const fullName = field(repository, "full_name");
  const owner =
    typeof fullName === "string" && fullName.includes("/")
      ? fullName.split("/", 1)[0]
      : field(field(repository, "owner"), "login");
  return typeof owner === "string" && owner !== "" ? { login: owner, uninstall: false } : undefined;
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
  const account = eventAccount(eventName, payload);
  if (account && !isGitHubAccountAllowed(trustedAccounts(app.ownerLogin, deps.allowedAccounts()), account.login)) {
    // Never the body: only the account and what we do about it.
    log.warn(
      { event: eventName, account: account.login, installationId: account.installationId, deliveryId },
      "GitHub event from an account this server does not serve ignored",
    );
    const uninstall = deps.uninstallInstallation;
    const installationId = account.installationId;
    return {
      status: 202,
      body: { ignored: "account_not_allowed" },
      ...(account.uninstall && uninstall && installationId !== undefined
        ? {
            afterResponse: async () => {
              // Destructive, so re-check against a fresh owner read: the cached
              // owner may be stale after an ownership transfer or rename.
              let fresh: { ownerLogin: string };
              try {
                fresh = await deps.appIdentity({ fresh: true });
              } catch (err) {
                log.warn(
                  { err, account: account.login, installationId },
                  "could not re-read the App owner; not removing the App from the installation",
                );
                return;
              }
              if (isGitHubAccountAllowed(trustedAccounts(fresh.ownerLogin, deps.allowedAccounts()), account.login)) {
                log.info(
                  { account: account.login, installationId },
                  "account is served after re-reading the App owner; not removing the App from the installation",
                );
                return;
              }
              try {
                await uninstall(installationId);
                log.warn(
                  { account: account.login, installationId },
                  "removed the App from an installation on an account this server does not serve",
                );
              } catch (err) {
                log.warn(
                  { err, account: account.login, installationId },
                  "could not remove the App from a foreign installation",
                );
              }
            },
          }
        : {}),
    };
  }
  const event = normalizeGitHubEvent(eventName, payload, app, (dropped) =>
    log.info({ ...dropped, deliveryId }, "mention ignored: its author did not pass the pre-filter"),
  );
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
  await maybePruneHostEventDeliveries(deps.db, now);

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
      repoAccess: deps.repoAccess,
      ...(deps.issueTrackers ? { issueTrackers: deps.issueTrackers } : {}),
      mentionHandle: app.slug,
      ...(deps.mentionExplanations === false ? { mentionExplanations: false } : {}),
    });
    log.info(
      { event: event.kind, repository: event.repository, deliveryId, runIds: routed.runIds },
      "host event routed",
    );
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
      .catch((delErr: unknown) =>
        log.warn({ err: delErr }, "could not roll back the delivery record after a routing failure"),
      );
    throw err;
  }
}

export { resetPruneClockForTests } from "./deliveries.js";
