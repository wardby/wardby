import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { logger } from "../core/logger.js";
import { NativeEngine } from "../core/engine-native.js";
import { executeRun, type NativeRunProviders } from "../core/runner.js";
import type { LlmStreamEvent } from "../providers/llm/types.js";
import type { safeFetch } from "../sandbox/safe-fetch.js";
import {
  BROKER_CONFIG,
  BROKERED_VALUE,
  echoUpstream,
  GH_TOOL_CODE,
  identityCipher,
  memoryDatastore,
  MODEL,
  noMemory,
  script,
  scriptedModel,
  scriptFor,
  TOOL_CODE,
  usage,
} from "./fixtures.test-support.js";
import type { WorkerLauncher } from "./gateway.js";
import { loopbackLauncher } from "./loopback.js";
import { createProcessLauncher } from "./stdio.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// The real worker entry as a separate process, from source, with an empty environment.
const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const processLauncher = createProcessLauncher({
  command: process.execPath,
  args: ["--import", "tsx", "src/native-worker/main.ts"],
  env: {},
  cwd: REPO_ROOT,
});

describe.skipIf(!process.env.DATABASE_URL)("native sandbox worker parity (database)", () => {
  const db = createPrismaClient();
  const tag = randomUUID().slice(0, 8);
  const ownerId = `parity-owner-${tag}`;
  const agentId = `parity-agent-${tag}`;
  const toolId = `parity-tool-${tag}`;
  const secretId = `parity-secret-${tag}`;
  const childId = `parity-child-${tag}`;

  afterAll(async () => {
    const runs = await db.run.findMany({ where: { agentId: { in: [agentId, childId] } }, select: { id: true } });
    const runIds = runs.map((r) => r.id);
    await db.runModelUsage.deleteMany({ where: { runId: { in: runIds } } });
    await db.runAttribution.deleteMany({ where: { runId: { in: runIds } } });
    await db.run.deleteMany({ where: { id: { in: runIds } } });
    await db.agentTool.deleteMany({ where: { agentId } });
    await db.agentSecret.deleteMany({ where: { agentId } });
    await db.secret.deleteMany({ where: { id: { in: [secretId, `${secretId}-gh`] } } });
    await db.tool.deleteMany({ where: { id: { in: [toolId, `${toolId}-gh`] } } });
    await db.agentSubAgent.deleteMany({ where: { parentAgentId: agentId } });
    await db.agent.deleteMany({ where: { id: { in: [agentId, childId] } } });
    await db.principal.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
  });

  async function seed() {
    await db.principal.create({ data: { id: ownerId, subject: ownerId } });
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "Answer from notes.",
        model: MODEL,
        budgetUsd: 1,
        maxTurns: 4,
        ownerId,
      },
    });
    await db.tool.create({
      data: {
        id: toolId,
        name: "lookup",
        description: "Reads a note.",
        paramsZod: "z.object({ key: z.string() })",
        jsonSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
        code: TOOL_CODE,
        ownerId,
      },
    });
    await db.agentTool.create({
      data: {
        agentId,
        toolId,
        allowedSecrets: ["api"],
        allowedDatastorePrefixes: ["notes/"],
        capabilitiesGrantedById: ownerId,
      },
    });
    await db.secret.create({
      data: { id: secretId, name: "api", ciphertext: "s3cret-value-123", keyId: "test", ownerId },
    });
    await db.agentSecret.create({ data: { agentId, secretId, boundName: "api" } });
  }

  // Counts worker launches, so a test can prove the sandbox path (not the in-process engine) ran.
  let launches = 0;
  const counting = (launcher: WorkerLauncher): WorkerLauncher => ({
    run: (input, gateway, signal) => {
      launches += 1;
      return launcher.run(input, gateway, signal);
    },
  });

  async function runIn(
    mode: "control_plane" | "sandbox",
    launcher: WorkerLauncher = loopbackLauncher,
    turns: LlmStreamEvent[][] = script(),
    beforeStream?: (call: number, runId: string) => Promise<void>,
    sandboxFetch?: typeof safeFetch,
  ) {
    let runId = "";
    const { llm, requests } = scriptedModel(turns, beforeStream && ((call) => beforeStream(call, runId)));
    const datastore = memoryDatastore({ [`${agentId}:notes/a`]: "hello" });
    const texts: string[] = [];
    const providers: NativeRunProviders = {
      llm,
      engine: new NativeEngine(),
      datastore,
      secrets: identityCipher,
      memory: noMemory,
      // Both runs get the launcher: only the run's own snapshot decides where its engine runs.
      nativeSandbox: counting(launcher),
      sandboxFetch,
    };
    const run = await db.run.create({ data: { agentId, trigger: "manual", nativeExecutionMode: mode } });
    runId = run.id;
    const finished = await executeRun(run.id, providers, db, (delta) => texts.push(delta));
    const modelUsage = await db.runModelUsage.findMany({ where: { runId: run.id } });
    const children = await db.run.findMany({ where: { parentRunId: run.id } });
    return { finished, requests, datastore, texts, modelUsage, children, runId: run.id };
  }

  const summary = (r: Awaited<ReturnType<typeof runIn>>) => ({
    status: r.finished.status,
    finalText: r.finished.finalText,
    turns: r.finished.turns,
    tokensIn: r.finished.tokensIn,
    tokensOut: r.finished.tokensOut,
    costUsd: Number(r.finished.costUsd),
    error: r.finished.error,
    texts: r.texts,
    modelUsage: r.modelUsage.map(({ runId: _runId, ...rest }) => ({ ...rest, costUsd: Number(rest.costUsd) })),
  });

  it("produces the same answer, usage, tool effects, and model conversation in both modes", async () => {
    await seed();
    const inProcess = await runIn("control_plane");
    expect(launches).toBe(0);
    const sandboxed = await runIn("sandbox");
    const separateProcess = await runIn("sandbox", processLauncher);
    expect(launches).toBe(2);

    for (const result of [inProcess, sandboxed, separateProcess]) {
      expect(result.finished.status).toBe("succeeded");
      expect(result.finished.finalText).toBe("The note says hello.");
      expect(result.datastore.store.get(`${agentId}:notes/seen`)).toEqual({ key: "notes/a", keyLength: 16 });
    }
    expect(summary(sandboxed)).toEqual(summary(inProcess));
    expect(summary(separateProcess)).toEqual(summary(inProcess));
    // The model saw the same conversation, tool result included.
    expect(sandboxed.requests).toEqual(inProcess.requests);
    expect(separateProcess.requests).toEqual(inProcess.requests);
    const toolResult = sandboxed.requests[1].messages.find((m) => m.role === "tool");
    expect(toolResult?.content).toContain('{"note":"hello","keyLength":16}');
  });

  it("delegates to a control-plane sub-agent from a sandboxed run, with the same run tree", async () => {
    await db.agent.create({
      data: { id: childId, name: childId, systemPrompt: "Help.", model: MODEL, budgetUsd: 1, maxTurns: 2, ownerId },
    });
    await db.agentSubAgent.create({ data: { parentAgentId: agentId, childAgentId: childId, boundName: "helper" } });
    const turns = (): LlmStreamEvent[][] => [
      [
        { type: "tool_call", id: "d1", name: "delegate_to_helper", argsJson: JSON.stringify({ task: "say hi" }) },
        { type: "done", stopReason: "tool_use", usage: usage(300, 20) },
      ],
      [
        { type: "text", delta: "hi from child" },
        { type: "done", stopReason: "end_turn", usage: usage(200, 5) },
      ],
      [
        { type: "text", delta: "The helper said hi." },
        { type: "done", stopReason: "end_turn", usage: usage(450, 8) },
      ],
    ];
    const inProcess = await runIn("control_plane", loopbackLauncher, turns());
    const sandboxed = await runIn("sandbox", loopbackLauncher, turns());

    expect(sandboxed.finished.finalText).toBe("The helper said hi.");
    expect(summary(sandboxed)).toEqual(summary(inProcess));
    expect(sandboxed.requests).toEqual(inProcess.requests);
    const child = (r: typeof inProcess) =>
      r.children.map((c) => ({
        agentId: c.agentId,
        status: c.status,
        finalText: c.finalText,
        taskOverride: c.taskOverride,
        nativeExecutionMode: c.nativeExecutionMode,
        costUsd: Number(c.costUsd),
      }));
    expect(child(sandboxed)).toEqual(child(inProcess));
    expect(child(sandboxed)).toEqual([expect.objectContaining({ status: "succeeded", finalText: "hi from child" })]);
    await db.agentSubAgent.deleteMany({ where: { parentAgentId: agentId } });
  });

  it("reaches the same budget outcome in both modes", async () => {
    // Enough for the pre-flight check, not for the first turn's real cost: the run stops on budget.
    await db.agent.update({ where: { id: agentId }, data: { budgetUsd: 0.0005 } });
    const inProcess = await runIn("control_plane");
    const sandboxed = await runIn("sandbox");
    await db.agent.update({ where: { id: agentId }, data: { budgetUsd: 1 } });

    expect(inProcess.finished.status).not.toBe("succeeded");
    expect(summary(sandboxed)).toEqual(summary(inProcess));
  });

  it("brokers a secret identically in both modes and never exposes it", async () => {
    await db.secret.create({
      data: {
        id: `${secretId}-gh`,
        name: "gh",
        ciphertext: BROKERED_VALUE,
        keyId: "test",
        ownerId,
        broker: BROKER_CONFIG,
      },
    });
    await db.agentSecret.create({ data: { agentId, secretId: `${secretId}-gh`, boundName: "gh" } });
    await db.tool.create({
      data: {
        id: `${toolId}-gh`,
        name: "ghcall",
        description: "Calls GitHub with a brokered token.",
        paramsZod: "z.object({})",
        jsonSchema: { type: "object", properties: {} },
        code: GH_TOOL_CODE,
        ownerId,
      },
    });
    await db.agentTool.create({
      data: {
        agentId,
        toolId: `${toolId}-gh`,
        allowedSecrets: ["gh"],
        allowedHosts: ["api.github.com"],
        capabilitiesGrantedById: ownerId,
      },
    });

    // Tool console output: in every mode the trusted side (in-process host or gateway) logs it
    // through the shared logger's "sandbox-tool" child, so capture that child's lines.
    const consoleLines: string[] = [];
    const capture = Object.fromEntries(
      ["info", "warn", "error"].map((level) => [
        level,
        (...args: unknown[]) => consoleLines.push(JSON.stringify(args)),
      ]),
    );
    const realChild = logger.child.bind(logger);
    const childSpy = vi
      .spyOn(logger, "child")
      .mockImplementation(((bindings: Record<string, unknown>, options?: object) =>
        bindings.module === "sandbox-tool" ? capture : realChild(bindings, options)) as typeof logger.child);

    const turns = () => scriptFor("ghcall", {}, ["Fetched."]);
    const results = [];
    for (const [mode, launcher] of [
      ["control_plane", loopbackLauncher],
      ["sandbox", loopbackLauncher],
      ["sandbox", processLauncher],
    ] as const) {
      const upstream = echoUpstream();
      const result = await runIn(mode, launcher, turns(), undefined, upstream.impl);
      // The upstream got the credential...
      expect(upstream.authorizations).toEqual([`Bearer ${BROKERED_VALUE}`]);
      expect(result.finished.status).toBe("succeeded");
      // ...the model never did, and the tool result shows it redacted.
      expect(JSON.stringify(result.requests)).not.toContain(BROKERED_VALUE);
      const toolResult = result.requests[1].messages.find((m) => m.role === "tool");
      expect(toolResult?.content).toContain('{"status":200,"echo":"Bearer [REDACTED]"}');
      // The tool logged the (scrubbed) response body, and no log line carries the value.
      expect(consoleLines.join("\n")).toContain("sawAuth");
      expect(consoleLines.join("\n")).not.toContain(BROKERED_VALUE);
      consoleLines.length = 0;
      results.push(result);
    }
    childSpy.mockRestore();
    const [inProcess, sandboxed, separateProcess] = results;
    expect(summary(sandboxed)).toEqual(summary(inProcess));
    expect(summary(separateProcess)).toEqual(summary(inProcess));
    expect(sandboxed.requests).toEqual(inProcess.requests);
    expect(separateProcess.requests).toEqual(inProcess.requests);
  });

  it("stops a sandboxed run that is cancelled mid-run, records it cancelled, and serves nothing after", async () => {
    const result = await runIn("sandbox", loopbackLauncher, script(), async (call, runId) => {
      // An operator cancels while the first model call is in flight.
      if (call === 1)
        await db.run.update({ where: { id: runId }, data: { status: "cancelled", finishedAt: new Date() } });
    });
    expect(result.finished.status).toBe("cancelled");
    // The model was never called again, and the tool never ran.
    expect(result.requests).toHaveLength(1);
    expect(result.datastore.store.has(`${agentId}:notes/seen`)).toBe(false);
  });
});
