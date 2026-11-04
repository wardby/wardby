/**
 * Inbound webhook ingress — HTTP-framework-agnostic. Authenticated by the
 * per-webhook secret only (never OAuth): mounted as an unauthenticated
 * route in streamable-http.ts, matching the design's "route is
 * unauthenticated by OAuth" invariant.
 */
import type { PrismaClient } from "#prisma";
import type { Executor } from "../../providers/executor/types.js";
import type { IssueTrackerRegistry } from "../../providers/issue-tracker/types.js";
import { resolveWebhookRun } from "../../core/webhooks.js";
import { CodingTaskOverrideSchema } from "../../coding/protocol.js";

export interface WebhookIngressRequest {
  headers: Record<string, string | undefined>;
  body: Record<string, unknown>;
}

export interface WebhookIngressResult {
  status: number;
  body: Record<string, unknown>;
}

function extractSecret(req: WebhookIngressRequest): string | undefined {
  return req.headers["x-webhook-secret"] ?? (typeof req.body.secret === "string" ? req.body.secret : undefined);
}

function extractCodingTask(req: WebhookIngressRequest): string | undefined {
  if (req.body.task === undefined) return undefined;
  const parsed = CodingTaskOverrideSchema.safeParse(req.body.task);
  return parsed.success ? parsed.data : undefined;
}

export async function handleWebhookIngress(
  webhookId: string,
  req: WebhookIngressRequest,
  db: PrismaClient,
  executor: Executor,
  issueTrackers?: IssueTrackerRegistry,
): Promise<WebhookIngressResult> {
  const secret = extractSecret(req);
  if (!secret) {
    return { status: 401, body: { error: "invalid_secret", error_description: "No webhook secret presented." } };
  }

  const codingTask = extractCodingTask(req);
  if (req.body.task !== undefined && codingTask === undefined) {
    return { status: 400, body: { error: "invalid_task" } };
  }

  // `wardbyRepository`, not `repository`, for the same reason: a forwarded GitHub
  // payload carries its own top-level `repository` object.
  const repository = req.body.wardbyRepository;
  if (
    repository !== undefined &&
    (typeof repository !== "string" || repository.length === 0 || repository.length > 300)
  ) {
    return { status: 400, body: { error: "invalid_repository" } };
  }

  // `wardbyIssue`, not `issue`: forwarded third-party payloads (GitHub, Jira)
  // carry their own top-level `issue` object, which is not ours to read.
  const result = await resolveWebhookRun(webhookId, secret, db, executor, codingTask, {
    issue: req.body.wardbyIssue,
    issueTrackers,
    repository,
  });
  if (result.ok) {
    return { status: 202, body: { runId: result.runId } };
  }
  switch (result.reason) {
    case "invalid_issue":
      return { status: 400, body: { error: "invalid_issue", error_description: result.message } };
    case "invalid_repository":
      return { status: 400, body: { error: "invalid_repository" } };
    case "not_found":
      return { status: 404, body: { error: "not_found" } };
    case "invalid_secret":
      return { status: 401, body: { error: "invalid_secret" } };
    case "disabled":
      return { status: 403, body: { error: "disabled" } };
  }
}
