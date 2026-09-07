/**
 * Inbound webhook ingress — HTTP-framework-agnostic. Authenticated by the
 * per-webhook secret only (never OAuth): mounted as an unauthenticated
 * route in streamable-http.ts, matching the design's "route is
 * unauthenticated by OAuth" invariant.
 */
import type { PrismaClient } from "@prisma/client";
import type { Executor } from "../../providers/executor/types.js";
import { resolveWebhookRun } from "../../core/webhooks.js";

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

export async function handleWebhookIngress(
  webhookId: string,
  req: WebhookIngressRequest,
  db: PrismaClient,
  executor: Executor,
): Promise<WebhookIngressResult> {
  const secret = extractSecret(req);
  if (!secret) {
    return { status: 401, body: { error: "invalid_secret", error_description: "No webhook secret presented." } };
  }

  const result = await resolveWebhookRun(webhookId, secret, db, executor);
  if (result.ok) {
    return { status: 202, body: { runId: result.runId } };
  }
  switch (result.reason) {
    case "not_found":
      return { status: 404, body: { error: "not_found" } };
    case "invalid_secret":
      return { status: 401, body: { error: "invalid_secret" } };
    case "disabled":
      return { status: 403, body: { error: "disabled" } };
  }
}
