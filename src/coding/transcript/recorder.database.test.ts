import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../core/db.js";
import { LocalBlobStore } from "../../providers/storage/local.js";
import { formatTranscriptFile } from "./format.js";
import { RunTranscriptRecorder, transcriptBlobKey } from "./recorder.js";

const db = createPrismaClient();
const SID = "00000000-0000-4000-8000-000000000001";
const agentIds: string[] = [];
const dirs: string[] = [];

describe.skipIf(!process.env.DATABASE_URL)("RunTranscriptRecorder (PostgreSQL)", () => {
  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.$disconnect();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it("upserts, prunes expired rows with their blobs, and cascades with the run", async () => {
    const agent = await db.agent.create({
      data: { name: `transcript-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
    });
    agentIds.push(agent.id);
    const run = await db.run.create({ data: { agentId: agent.id, status: "succeeded" } });
    const dir = await mkdtemp(join(tmpdir(), "transcript-db-"));
    dirs.push(dir);
    const blobs = new LocalBlobStore(dir);
    let now = new Date();
    const recorder = new RunTranscriptRecorder({
      db,
      blobs,
      secretValues: async () => ["s3cret-value"],
      retentionDays: 1,
      maxBytes: 10 * 1024 * 1024,
      now: () => now,
    });
    const user = JSON.stringify({
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: SID,
      message: { role: "user", content: "hi" },
    });
    const assistant = JSON.stringify({
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: SID,
      message: { role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
    });
    const file = formatTranscriptFile(
      { type: "wardby-transcript", version: 1, provider: "claude-code", sessionId: SID, status: "ok" },
      [user, assistant],
    );
    const input = {
      runId: run.id,
      agentId: agent.id,
      provider: "claude-code",
      capability: "cap",
      read: async () => file as string | undefined,
    };

    expect(await recorder.record(input)).toBe("stored");
    expect(await recorder.record(input)).toBe("stored");
    expect(await db.runTranscript.count({ where: { runId: run.id } })).toBe(1);
    expect(await db.runTranscript.findUnique({ where: { runId: run.id } })).toMatchObject({
      status: "stored",
      blobKey: transcriptBlobKey(run.id),
    });

    now = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    expect(await recorder.pruneExpired()).toBeGreaterThanOrEqual(1);
    expect(await db.runTranscript.count({ where: { runId: run.id } })).toBe(0);
    expect(await blobs.head(transcriptBlobKey(run.id))).toBeNull();

    // Cascade: deleting the run removes a fresh row.
    now = new Date();
    expect(await recorder.record(input)).toBe("stored");
    await db.run.delete({ where: { id: run.id } });
    expect(await db.runTranscript.count({ where: { runId: run.id } })).toBe(0);
  });
});
