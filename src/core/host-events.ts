/**
 * Host-neutral routing of code-review host events (GitHub App webhooks today)
 * to the native agents linked to that repository. Adapters normalise their
 * payloads into HostEvent (providers/review-host/github-events.ts); this
 * module decides which agents run. See
 * docs/private/2026-09-25-code-review-host-design.md §6.3.
 */
import type { PrismaClient } from "#prisma";
import type { Executor } from "../providers/executor/types.js";
import type { CodeReviewHost, HostEvent, ReviewHostRegistry } from "../providers/review-host/types.js";
import { dispatchRun } from "./dispatch.js";
import { logger } from "./logger.js";

export type { HostEvent };

const log = logger.child({ module: "host-events" });
const MAX_TASK_BODY = 8000;

export type HostEventDb = Pick<
  PrismaClient,
  "agentRepository" | "agent" | "run" | "runHostCheck" | "codingRun" | "task" | "webhook" | "$transaction" | "$queryRaw"
>;

export interface RouteHostEventDeps {
  db: HostEventDb;
  executor: Executor;
  hosts: ReviewHostRegistry;
  /** The App's @-handle without the "@", e.g. "wardby". */
  mentionHandle: string;
}

export interface RouteResult {
  runIds: string[];
  /** Cosmetic work to do after the webhook response is sent (reactions). */
  followUps: Array<() => Promise<void>>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isReviewCommand(body: string, mentionHandle: string): boolean {
  return new RegExp(`(^|[^\\w-])@${escapeRegExp(mentionHandle)}\\s+review(?![\\w-])`, "i").test(body);
}

interface ReviewTarget {
  agentId: string;
  checkName: string;
}

async function startReviews(
  deps: RouteHostEventDeps,
  host: CodeReviewHost,
  repository: string,
  prNumber: number,
  headSha: string,
  targets: ReviewTarget[],
): Promise<string[]> {
  const runIds: string[] = [];
  for (const target of targets) {
    let checkId: string | null = null;
    try {
      checkId = (await host.startCheck(repository, { headSha, name: target.checkName })).checkId;
    } catch (err) {
      // The review still runs; repo_publish_review creates the check itself.
      log.warn({ err, repository, prNumber, agentId: target.agentId }, "could not start the review check");
    }
    try {
      const dispatched = await dispatchRun({
        db: deps.db,
        executor: deps.executor,
        agentId: target.agentId,
        trigger: "host_event",
        taskOverride: `Review pull request #${prNumber} in ${repository} (head ${headSha}).`,
        afterPersist: checkId
          ? async (tx, run) => {
              await tx.runHostCheck.create({
                data: { runId: run.id, provider: host.provider, repository, checkId, headSha },
              });
            }
          : undefined,
      });
      if (!dispatched) throw new Error("dispatch_refused");
      runIds.push(dispatched.run.id);
      log.info({ repository, prNumber, agentId: target.agentId, runId: dispatched.run.id }, "review run dispatched");
    } catch (err) {
      log.warn({ err, repository, prNumber, agentId: target.agentId }, "review run could not be dispatched");
      if (checkId) {
        await host
          .completeCheck(repository, {
            checkId,
            conclusion: "neutral",
            title: "Review could not be started",
            summary: "wardby could not start this review. Use Re-run to try again.",
          })
          .catch((e: unknown) => log.warn({ err: e, repository, prNumber }, "could not complete the unstarted check"));
      }
    }
  }
  return runIds;
}

export async function routeHostEvent(event: HostEvent, deps: RouteHostEventDeps): Promise<RouteResult> {
  const none: RouteResult = { runIds: [], followUps: [] };
  const host = deps.hosts[event.provider];
  if (!host) return none;
  const links = await deps.db.agentRepository.findMany({
    where: { provider: event.provider, repository: event.repository },
  });
  const reviewers = links
    .filter((l) => l.access === "write" && l.triggers.includes("pull_request") && l.checkName)
    .map((l) => ({ agentId: l.agentId, checkName: l.checkName! }));

  switch (event.kind) {
    case "pr_updated": {
      if (event.isFork || reviewers.length === 0) return none;
      return {
        runIds: await startReviews(deps, host, event.repository, event.prNumber, event.headSha, reviewers),
        followUps: [],
      };
    }
    case "check_rerun": {
      const owner = reviewers.filter((r) => r.checkName === event.checkName);
      if (owner.length === 0) return none;
      return {
        runIds: await startReviews(deps, host, event.repository, event.prNumber, event.headSha, owner),
        followUps: [],
      };
    }
    case "mention": {
      const react = async () => {
        await host.acknowledge(event.repository, event.comment).catch((err: unknown) => {
          log.warn({ err, repository: event.repository, number: event.number }, "could not add the reaction");
        });
      };
      if (event.isPullRequest && isReviewCommand(event.body, deps.mentionHandle)) {
        if (reviewers.length === 0) return none;
        const head = await host.pullRequestHead(event.repository, event.number);
        if (head.isFork || head.state !== "open") return none;
        return {
          runIds: await startReviews(deps, host, event.repository, event.number, head.headSha, reviewers),
          followUps: [react],
        };
      }
      const responder = links.find((l) => l.access === "write" && l.triggers.includes("mention"));
      if (!responder) return none;
      const header = `[${event.repository} ${event.isPullRequest ? "PR" : "issue"} #${event.number}, comment by @${event.author}${
        event.replyToReviewCommentId ? `, in review thread ${event.replyToReviewCommentId}` : ""
      }]`;
      const dispatched = await dispatchRun({
        db: deps.db,
        executor: deps.executor,
        agentId: responder.agentId,
        trigger: "host_event",
        taskOverride: `${header}\n\n${event.body.slice(0, MAX_TASK_BODY)}`,
      });
      if (!dispatched) return none;
      log.info(
        { repository: event.repository, number: event.number, runId: dispatched.run.id },
        "mention run dispatched",
      );
      return { runIds: [dispatched.run.id], followUps: [react] };
    }
  }
}
