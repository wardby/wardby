/**
 * Webhooks: an inbound trigger for an agent, authenticated by a per-webhook
 * secret (not OAuth — see ingress.ts). The secret is high-entropy
 * (32 random bytes), so a plain SHA-256 hash is sufficient — unlike a
 * user-chosen password, there's no low-entropy guessing surface a pepper/
 * HMAC key would meaningfully defend against; this mirrors how GitHub/
 * Stripe-style API tokens are stored (hash of a random token, no extra key).
 * Comparison is constant-time (`timingSafeEqual` over the raw digest, which
 * is always 32 bytes, so there's no length-mismatch case to special-case).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentKind, CodingAgentProfile, PrismaClient, Webhook } from "@prisma/client";
import type { Executor } from "../providers/executor/types.js";
import { dispatchRun } from "./dispatch.js";

export type WebhookMetadata = Pick<Webhook, "id" | "agentId" | "status" | "ownerId" | "createdAt" | "lastFiredAt">;

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Whether a webhook is allowed to hand this agent per-run task text.
 * Coding agents keep the existing explicit opt-in (allowWebhookTaskOverride)
 * since the text can drive real repository changes. A native agent has no
 * per-run input at all otherwise (its systemPrompt is fixed) and the
 * resulting run is sandboxed, so accepting task text needs no separate
 * opt-in — always allowed once the caller already holds the webhook secret.
 */
function taskAllowed(kind: AgentKind, codingProfile: CodingAgentProfile | null): boolean {
  if (kind === "native") return true;
  return kind === "coding" && (codingProfile?.allowWebhookTaskOverride ?? false);
}

function secretMatches(presented: string, storedHash: string): boolean {
  const presentedHash = Buffer.from(hashSecret(presented), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (presentedHash.length !== stored.length) return false;
  return timingSafeEqual(presentedHash, stored);
}

/** Creates a webhook and returns the raw secret ONCE — only its hash is ever stored. */
export async function createWebhook(
  agentId: string,
  ownerId: string,
  db: PrismaClient,
): Promise<{ id: string; secret: string }> {
  const secret = randomBytes(32).toString("base64url");
  const webhook = await db.webhook.create({ data: { agentId, ownerId, secretHash: hashSecret(secret) } });
  return { id: webhook.id, secret };
}

export async function listWebhooks(ownerId: string, db: PrismaClient): Promise<WebhookMetadata[]> {
  const webhooks = await db.webhook.findMany({ where: { ownerId } });
  return webhooks.map(({ id, agentId, status, ownerId: owner, createdAt, lastFiredAt }) => ({
    id,
    agentId,
    status,
    ownerId: owner,
    createdAt,
    lastFiredAt,
  }));
}

export async function deleteWebhook(id: string, db: PrismaClient): Promise<void> {
  await db.webhook.delete({ where: { id } });
}

export type ResolveWebhookRunResult =
  { ok: true; runId: string } | { ok: false; reason: "not_found" | "invalid_secret" | "disabled" };

/**
 * Validates the presented secret and, if valid + enabled, enqueues a run via
 * the exact same `createRun` path `trigger_agent`/the scheduler use — the
 * budget guardrail applies identically regardless of what triggered the run.
 */
export async function resolveWebhookRun(
  id: string,
  presentedSecret: string,
  db: PrismaClient,
  executor: Executor,
  codingTask?: string,
): Promise<ResolveWebhookRunResult> {
  const webhook = await db.webhook.findUnique({ where: { id } });
  if (!webhook) return { ok: false, reason: "not_found" };
  if (!secretMatches(presentedSecret, webhook.secretHash)) return { ok: false, reason: "invalid_secret" };
  if (webhook.status !== "enabled") return { ok: false, reason: "disabled" };

  const agent = await db.agent.findUnique({ where: { id: webhook.agentId }, include: { codingProfile: true } });
  if (!agent) return { ok: false, reason: "not_found" };
  if (codingTask !== undefined && !taskAllowed(agent.kind, agent.codingProfile)) {
    return { ok: false, reason: "disabled" };
  }

  let rejected: "not_found" | "invalid_secret" | "disabled" = "disabled";
  const dispatched = await dispatchRun({
    db,
    executor,
    agentId: agent.id,
    trigger: "webhook",
    // Coding agents keep the existing per-agent opt-in (allowWebhookTaskOverride);
    // a native agent's system prompt has no per-run input at all otherwise, so
    // accepting task text over an authenticated webhook call needs no separate
    // opt-in — it's a much lower-risk capability than a coding agent being told
    // to modify a real repository.
    codingTask: agent.kind === "coding" ? codingTask : undefined,
    taskOverride: agent.kind === "native" ? codingTask : undefined,
    beforePersist: async (tx, currentAgent) => {
      const current = await tx.webhook.findUnique({ where: { id } });
      if (!current) {
        rejected = "not_found";
        return false;
      }
      if (!secretMatches(presentedSecret, current.secretHash)) {
        rejected = "invalid_secret";
        return false;
      }
      if (current.status !== "enabled") {
        rejected = "disabled";
        return false;
      }
      if (codingTask !== undefined && !taskAllowed(currentAgent.kind, currentAgent.codingProfile)) {
        rejected = "disabled";
        return false;
      }
      await tx.webhook.update({ where: { id }, data: { lastFiredAt: new Date() } });
      return true;
    },
  });
  if (!dispatched) return { ok: false, reason: rejected };
  return { ok: true, runId: dispatched.run.id };
}
