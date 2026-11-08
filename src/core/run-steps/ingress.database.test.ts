import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "../db.js";
import { capabilityHash } from "../../providers/coding-proxy/capability-hash.js";
import { startRunStepIngress } from "./ingress.js";
import { stepSummary } from "./summarize.js";
import { RUN_STEPS_INGRESS_PATH, type ExtractedStep } from "./types.js";
import { RunStepWriter } from "./writer.js";

const db = createPrismaClient();
const agentIds: string[] = [];
// Fake values only: never a real credential.
const CAP = `rrp_${"C".repeat(43)}`;
const FAKE_SECRET = "wbFake-Secret-Value-7f3a91";
const FAKE_TOKEN = "ghp_FAKEfakeFAKEfake0123456789abcd";
/** A multi-word secret with a token-shaped word inside it. */
const P2 = `correct horse ${FAKE_TOKEN} staple`;

describe.skipIf(!process.env.DATABASE_URL)("run-steps listener (PostgreSQL)", () => {
  let server: Server;
  let url: string;
  const ingressWarn = vi.fn();
  const writerWarn = vi.fn();

  beforeAll(async () => {
    const writer = new RunStepWriter({
      db,
      secretValues: async () => [FAKE_SECRET, P2],
      level: "summary",
      retentionDays: 30,
      log: { warn: writerWarn },
    });
    server = await startRunStepIngress(
      { host: "127.0.0.1", port: 0 },
      { db, sink: writer, log: { warn: ingressWarn } },
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${RUN_STEPS_INGRESS_PATH}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.run.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.$disconnect();
  });

  /** A running coding run with a proxy session whose capability is `capability`. */
  async function codingRun(capability: string, deadlineAt = new Date(Date.now() + 60_000)): Promise<string> {
    const agent = await db.agent.create({
      data: { name: `ingress-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
    });
    agentIds.push(agent.id);
    const run = await db.run.create({ data: { agentId: agent.id, status: "running" } });
    await db.codingRun.create({
      data: {
        runId: run.id,
        task: "test",
        repository: "your-org/your-repo",
        baseRef: "main",
        headRef: `wardby/run-${run.id}`,
        provider: "claude-code",
        model: "claude-sonnet-4-6",
        timeoutSec: 60,
        protectedPaths: [],
        budgetReservedUsd: 0.01,
      },
    });
    await db.codingProxySession.create({
      data: {
        runId: run.id,
        capabilityHash: capabilityHash(capability),
        credentialRef: "anthropic/test",
        protocol: "anthropic-messages",
        allowedModels: ["claude-sonnet-4-6"],
        deadlineAt,
        budgetUsd: 1,
      },
    });
    return run.id;
  }

  const post = (body: string, authorization = `Bearer ${CAP}`) =>
    fetch(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body });

  it("stores an unmasked proxy batch with the agent's exact values and the run capability removed", async () => {
    const runId = await codingRun(CAP);
    const steps: ExtractedStep[] = [
      {
        kind: "tool",
        callId: "c1",
        tool: "Bash",
        text: `curl -H "token ${FAKE_TOKEN}" https://x.test/${FAKE_SECRET}`,
        truncated: false,
      },
      { kind: "said", callId: "said:m1:0", text: `I will use ${FAKE_SECRET}.`, truncated: false },
      // The capability that authenticated the POST, whole and glued to other text.
      { kind: "said", callId: "said:m1:1", text: `token ${CAP} and x${CAP}y`, truncated: false },
      // A cut copy too short for the token shape: only the exact value (passed by the listener) catches it.
      { kind: "said", callId: "said:m1:2", text: `cut x${CAP.slice(0, 7)}`, truncated: true },
      // A multi-word secret with a token-shaped word inside, sent as the model wrote it.
      { kind: "said", callId: "said:m1:3", text: `use ${P2} now`, truncated: false },
    ];
    // The cut copy survives a redaction that doesn't know the capability: the listener's extra value matters.
    expect(stepSummary(steps[3], [FAKE_SECRET, P2])).toContain(CAP.slice(0, 7));

    const response = await post(JSON.stringify({ runId, steps, results: [{ callId: "c1", status: "exit 1" }] }));
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('{"ok":true}');

    const rows = await db.runStep.findMany({ where: { runId }, orderBy: { seq: "asc" } });
    expect(rows.map((r) => r.summary)).toEqual([
      'curl -H "token [REDACTED]" https://x.test/[REDACTED]',
      "I will use [REDACTED].",
      "token [REDACTED] and x[REDACTED]y",
      "cut x[REDACTED]",
      "use [REDACTED] now",
    ]);
    expect(rows[0].status).toBe("exit 1");
    const stored = JSON.stringify(rows);
    for (const value of [FAKE_SECRET, FAKE_TOKEN, CAP, CAP.slice(0, 7), "correct", "horse", "staple"]) {
      expect(stored).not.toContain(value);
    }
    expect(ingressWarn).not.toHaveBeenCalled();
    expect(writerWarn).not.toHaveBeenCalled();
  });

  it("refuses a wrong capability, another run's id, and an ended session, storing nothing and logging no value", async () => {
    const runId = await codingRun(`rrp_${"D".repeat(43)}`);
    const otherRunId = await codingRun(`rrp_${"E".repeat(43)}`, new Date(Date.now() - 11 * 60_000));
    const body = (id: string) =>
      JSON.stringify({
        runId: id,
        steps: [{ kind: "said", callId: "said:m1:0", text: `use ${FAKE_SECRET}`, truncated: false }],
        results: [],
      });
    const WRONG = `rrp_${"W".repeat(43)}`;

    const wrong = await post(body(runId), `Bearer ${WRONG}`);
    expect([wrong.status, await wrong.text()]).toEqual([401, '{"error":"unauthorized"}']);
    const mismatch = await post(body(otherRunId), `Bearer rrp_${"D".repeat(43)}`);
    expect([mismatch.status, await mismatch.text()]).toEqual([403, '{"error":"run_mismatch"}']);
    const ended = await post(body(otherRunId), `Bearer rrp_${"E".repeat(43)}`);
    expect([ended.status, await ended.text()]).toEqual([403, '{"error":"session_ended"}']);

    expect(await db.runStep.count({ where: { runId: { in: [runId, otherRunId] } } })).toBe(0);
    expect(ingressWarn).not.toHaveBeenCalled();
    expect(writerWarn).not.toHaveBeenCalled();
  });
});
