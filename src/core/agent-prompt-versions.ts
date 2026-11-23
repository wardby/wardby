/**
 * An agent's system-prompt history: an append-only AgentPromptVersion row per distinct prompt,
 * the highest number always equal to Agent.systemPrompt.
 *
 * Output (CLAUDE.md "Secrets never leave their boundary"): stored text is raw, exactly like the live
 * column, so restore never swaps a working prompt for a masked one. Every output path redacts by exact
 * secret value (readPromptVersion) and fails closed; list returns metadata only; restore returns
 * numbers and the two prompt strings for the caller's in-process comparison, never for output.
 */
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "#prisma";
import { loadAgentSecretValues } from "./secret-guard.js";
import { redactExactSecretValues } from "./secret-spans.js";

type Cipher = Parameters<typeof loadAgentSecretValues>[1];
type Db = Pick<PrismaClient, "agentPromptVersion">;

export const DEFAULT_PROMPT_VERSIONS_PAGE = 50;
export const MAX_PROMPT_VERSIONS_PAGE = 200;

export type PromptVersionVia = "create" | "update" | "restore" | "import" | "cli" | "seed" | "backfill";

const hashOf = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Records `systemPrompt` as the next version unless it equals the latest one; safe to call after any prompt write. */
export async function recordPromptVersion(
  db: Db,
  input: {
    agentId: string;
    systemPrompt: string;
    via: PromptVersionVia;
    createdById?: string | null;
    summary?: string;
  },
): Promise<void> {
  const latest = await db.agentPromptVersion.findFirst({
    where: { agentId: input.agentId },
    orderBy: { number: "desc" },
    select: { number: true, contentHash: true },
  });
  const contentHash = hashOf(input.systemPrompt);
  if (latest?.contentHash === contentHash) return;
  await db.agentPromptVersion.create({
    data: {
      agentId: input.agentId,
      number: (latest?.number ?? 0) + 1,
      systemPrompt: input.systemPrompt,
      contentHash,
      via: input.via,
      createdById: input.createdById ?? null,
      summary: input.summary ?? null,
    },
  });
}

/** Metadata only, newest first. */
export async function listPromptVersions(db: Db, agentId: string, limit = DEFAULT_PROMPT_VERSIONS_PAGE) {
  const rows = await db.agentPromptVersion.findMany({
    where: { agentId },
    orderBy: { number: "desc" },
    take: Math.min(Math.max(1, limit), MAX_PROMPT_VERSIONS_PAGE),
    select: {
      number: true,
      contentHash: true,
      via: true,
      createdById: true,
      summary: true,
      createdAt: true,
      systemPrompt: true,
    },
  });
  return rows.map(({ systemPrompt, ...meta }) => ({ ...meta, chars: systemPrompt.length }));
}

/** One version, its text redacted by exact value of the agent's secrets; rejects (no text) if the secrets cannot be loaded. */
export async function readPromptVersion(db: PrismaClient, cipher: Cipher, agentId: string, number: number) {
  const row = await db.agentPromptVersion.findUnique({ where: { agentId_number: { agentId, number } } });
  if (!row) throw new Error("agent_prompt_version_not_found");
  const values = (await loadAgentSecretValues(db, cipher, agentId)).flatMap((e) => e.values);
  const { systemPrompt, ...meta } = row;
  return { ...meta, systemPromptText: redactExactSecretValues(systemPrompt, values) };
}

/** Makes a stored version the live prompt as a NEW version. `before`/`after` are for in-process comparison only. */
export async function restorePromptVersion(
  db: PrismaClient,
  input: { agentId: string; number: number; baseNumber: number; createdById: string },
): Promise<{ number: number; before: string; after: string }> {
  return db.$transaction(
    async (tx) => {
      const latest = await tx.agentPromptVersion.findFirst({
        where: { agentId: input.agentId },
        orderBy: { number: "desc" },
        select: { number: true },
      });
      if (latest && latest.number !== input.baseNumber) throw new Error("agent_prompt_version_conflict");
      const target = await tx.agentPromptVersion.findUnique({
        where: { agentId_number: { agentId: input.agentId, number: input.number } },
      });
      if (!target) throw new Error("agent_prompt_version_not_found");
      const agent = await tx.agent.findUnique({ where: { id: input.agentId }, select: { systemPrompt: true } });
      if (!agent) throw new Error("agent_prompt_version_not_found");
      if (input.number === input.baseNumber || target.systemPrompt === agent.systemPrompt) {
        throw new Error("agent_prompt_version_is_latest");
      }
      await tx.agent.update({ where: { id: input.agentId }, data: { systemPrompt: target.systemPrompt } });
      await recordPromptVersion(tx, {
        agentId: input.agentId,
        systemPrompt: target.systemPrompt,
        via: "restore",
        createdById: input.createdById,
        summary: `Restored v${input.number}`,
      });
      const now = await tx.agentPromptVersion.findFirst({
        where: { agentId: input.agentId },
        orderBy: { number: "desc" },
        select: { number: true },
      });
      return { number: now!.number, before: agent.systemPrompt, after: target.systemPrompt };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
