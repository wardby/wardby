import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { interruptPending, joinedPrincipals, joinRefusal, pollJoin } from "./join.js";
import { RunStepWriter } from "./writer.js";
import type { AddressInfo } from "node:net";
import { capabilityHash } from "../../providers/coding-proxy/capability-hash.js";
import { startRunStepIngress } from "./ingress.js";
import { RUN_JOIN_POLL_PATH } from "./types.js";

const db = createPrismaClient();
const agentIds: string[] = [];
// Fake values only: never a real credential.
const FAKE_SECRET = "wbFake-Join-Secret-4d2e77";

async function newRun(opts: { status?: "running" | "succeeded"; level?: "off" | "summary" | "detail" | null } = {}) {
  const agent = await db.agent.create({
    data: { name: `join-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
  });
  agentIds.push(agent.id);
  return db.run.create({
    data: { agentId: agent.id, status: opts.status ?? "running", runStepsLevel: opts.level ?? null },
  });
}

function writer(level: "off" | "summary" | "detail" = "summary") {
  return new RunStepWriter({ db, secretValues: async () => [FAKE_SECRET], level, retentionDays: 30 });
}

afterAll(async () => {
  await db.run.deleteMany({ where: { agentId: { in: agentIds } } });
  await db.agent.deleteMany({ where: { id: { in: agentIds } } });
  await db.$disconnect();
});

describe("join steps (PostgreSQL)", () => {
  it("records join, message and leave steps in seq order, masking a secret in a message", async () => {
    const run = await newRun();
    const w = writer();
    const joined = await w.recordJoin(run.id, { kind: "join", principalId: "p1" });
    const sent = await w.recordJoin(run.id, {
      kind: "message",
      principalId: "p1",
      text: `use the key ${FAKE_SECRET} \u001b[31mnow\u001b[0m`,
    });
    const left = await w.recordJoin(run.id, { kind: "leave", principalId: "p1" });
    expect([joined.seq, sent.seq, left.seq]).toEqual([1, 2, 3]);
    expect(sent.text).toBe("use the key [REDACTED] now");
    const rows = await db.runStep.findMany({ where: { runId: run.id }, orderBy: { seq: "asc" } });
    expect(rows.map((r) => [r.kind, r.summary, r.fromPrincipalId])).toEqual([
      ["join", "joined", "p1"],
      ["message", "use the key [REDACTED] now", "p1"],
      ["leave", "left", "p1"],
    ]);
    expect(rows[1].detail).toBe("use the key [REDACTED] now");
    expect(JSON.stringify(rows)).not.toContain(FAKE_SECRET);
  });

  it("refuses join steps when the run keeps no steps", async () => {
    const run = await newRun({ level: "off" });
    await expect(writer().recordJoin(run.id, { kind: "join", principalId: "p1" })).rejects.toThrow("join_unavailable");
    await expect(writer("off").recordJoin(run.id, { kind: "join", principalId: "p1" })).rejects.toThrow(
      "join_unavailable",
    );
  });

  it("tracks who is joined by each principal's latest join or leave", async () => {
    const run = await newRun();
    const w = writer();
    await w.recordJoin(run.id, { kind: "join", principalId: "a" });
    await w.recordJoin(run.id, { kind: "join", principalId: "b" });
    await w.recordJoin(run.id, { kind: "leave", principalId: "a" });
    expect([...(await joinedPrincipals(db, run.id))]).toEqual(["b"]);
  });

  it("answers a poll at once with new messages and marks them delivered; holds only while joined", async () => {
    const run = await newRun();
    const w = writer();
    // Nobody joined: answers at once, even with a long window.
    const started = Date.now();
    expect(await pollJoin(db, run.id, { after: 0, joined: false }, { windowMs: 5_000 })).toEqual({
      joined: false,
      messages: [],
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    await w.recordJoin(run.id, { kind: "join", principalId: "p1" });
    // The joined state changed: answers at once.
    expect(await pollJoin(db, run.id, { after: 0, joined: false }, { windowMs: 5_000 })).toEqual({
      joined: true,
      messages: [],
    });
    const { seq } = await w.recordJoin(run.id, { kind: "interrupt", principalId: "p1", text: "stop" });
    const answer = await pollJoin(db, run.id, { after: 0, joined: true }, { windowMs: 5_000 });
    expect(answer).toEqual({ joined: true, messages: [{ seq, text: "stop", interrupt: true }] });
    const row = await db.runStep.findFirst({ where: { runId: run.id, seq } });
    expect(row?.deliveredAt).not.toBeNull();
    // Joined and nothing new: held for the window, then the same state.
    const held = Date.now();
    expect(await pollJoin(db, run.id, { after: seq, joined: true }, { windowMs: 1_500, intervalMs: 200 })).toEqual({
      joined: true,
      messages: [],
    });
    expect(Date.now() - held).toBeGreaterThanOrEqual(1_000);
  });

  it("joinRefusal: a running native run, or a running Claude Code run that is not a workflow run", async () => {
    const done = await newRun({ status: "succeeded" });
    expect(await joinRefusal(db, done.id)).toBe("run_not_running");
    const native = await newRun();
    expect(await joinRefusal(db, native.id)).toBeNull();
  });

  it("interruptPending sees an undelivered interrupt only, and delivers nothing", async () => {
    const run = await newRun();
    const w = writer();
    await w.recordJoin(run.id, { kind: "join", principalId: "p1" });
    const { seq: messageSeq } = await w.recordJoin(run.id, { kind: "message", principalId: "p1", text: "hi" });
    expect(await interruptPending(db, run.id, 0)).toBe(false);
    const { seq } = await w.recordJoin(run.id, { kind: "interrupt", principalId: "p1", text: "stop" });
    expect(await interruptPending(db, run.id, messageSeq)).toBe(true);
    expect(await interruptPending(db, run.id, seq)).toBe(false);
    const rows = await db.runStep.findMany({ where: { runId: run.id, deliveredAt: { not: null } } });
    expect(rows).toEqual([]);
    await pollJoin(db, run.id, { after: 0, joined: true }, { windowMs: 0 });
    expect(await interruptPending(db, run.id, messageSeq)).toBe(false);
  });

  it("the listener's join poll answers the capability's own run, and refuses an unknown capability", async () => {
    const run = await newRun();
    const w = writer();
    await w.recordJoin(run.id, { kind: "join", principalId: "p1" });
    const { seq } = await w.recordJoin(run.id, { kind: "message", principalId: "p1", text: "hello" });
    const capability = `rrp_${"J".repeat(43)}`;
    const session = { runId: run.id, deadlineAt: new Date(Date.now() + 60_000) };
    const fakeDb = {
      codingProxySession: {
        findUnique: async ({ where }: { where: { capabilityHash: string } }) =>
          where.capabilityHash === capabilityHash(capability) ? session : null,
      },
      runStep: db.runStep,
    } as never;
    const server = await startRunStepIngress(
      { host: "127.0.0.1", port: 0 },
      { db: fakeDb, sink: w, joinPollWindowMs: 500 },
    );
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${RUN_JOIN_POLL_PATH}`;
      const post = (authorization: string, body: unknown) =>
        fetch(url, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const ok = await post(`Bearer ${capability}`, { after: 0, joined: true });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ joined: true, messages: [{ seq, text: "hello", interrupt: false }] });
      expect((await post(`Bearer rrp_${"X".repeat(43)}`, { after: 0, joined: true })).status).toBe(401);
      expect((await post(`Bearer ${capability}`, { after: -1, joined: true })).status).toBe(400);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
