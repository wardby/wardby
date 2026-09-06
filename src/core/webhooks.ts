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
import type { PrismaClient, Webhook } from "@prisma/client";
import { createRun } from "./runner.js";

export type WebhookMetadata = Pick<Webhook, "id" | "agentId" | "status" | "ownerId" | "createdAt" | "lastFiredAt">;

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function secretMatches(presented: string, storedHash: string): boolean {
  const presentedHash = Buffer.from(hashSecret(presented), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (presentedHash.length !== stored.length) return false;
  return timingSafeEqual(presentedHash, stored);
}

/** Creates a webhook and returns the raw secret ONCE — only its hash is ever stored. */
export async function createWebhook(agentId: string, ownerId: string, db: PrismaClient): Promise<{ id: string; secret: string }> {
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
  | { ok: true; runId: string }
  | { ok: false; reason: "not_found" | "invalid_secret" | "disabled" };

/**
 * Validates the presented secret and, if valid + enabled, enqueues a
 * manual run via the exact same `createRun` path `trigger_agent`/the
 * scheduler use — the budget guardrail applies identically regardless of
 * what triggered the run.
 */
export async function resolveWebhookRun(id: string, presentedSecret: string, db: PrismaClient): Promise<ResolveWebhookRunResult> {
  const webhook = await db.webhook.findUnique({ where: { id } });
  if (!webhook) return { ok: false, reason: "not_found" };
  if (!secretMatches(presentedSecret, webhook.secretHash)) return { ok: false, reason: "invalid_secret" };
  if (webhook.status !== "enabled") return { ok: false, reason: "disabled" };

  const agent = await db.agent.findUnique({ where: { id: webhook.agentId } });
  if (!agent) return { ok: false, reason: "not_found" };

  const run = await createRun(db, agent.name, "manual");
  await db.webhook.update({ where: { id }, data: { lastFiredAt: new Date() } });
  return { ok: true, runId: run.id };
}
