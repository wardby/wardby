import { describe, expect, it, vi } from "vitest";
import type { Datastore } from "../providers/datastore/types.js";
import type { LlmProvider, LlmStreamEvent } from "../providers/llm/types.js";
import type { AgentMemoryStore } from "../providers/memory/types.js";
import type { SecretCipher } from "../providers/secrets/types.js";
import { NativeEngine } from "./engine-native.js";

const handled = vi.hoisted(() => [] as { name: string; args: string; ctx: Record<string, unknown> }[]);
vi.mock("./document-tools.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./document-tools.js")>();
  return {
    ...real,
    handleDocumentTool: vi.fn(async (name: string, args: string, ctx: Record<string, unknown>) => {
      handled.push({ name, args, ctx });
      return JSON.stringify({ ok: true, id: "doc-1", tool: name });
    }),
  };
});
import { createNativeRunTools, executeRun, sandboxWorkerInput, type RunnerDb } from "./runner.js";

// The doc_* built-ins in a native run (#625): offered by the stored documentTools setting, native
// agents only, dispatched live, and served through the sandbox gateway like any other built-in.

const READ = ["doc_list", "doc_get", "doc_list_threads", "doc_get_thread"];
const ALL_NINE = 9;
const toolCall = (name: string, args: unknown): LlmStreamEvent[] => [
  { type: "tool_call", id: "c1", name, argsJson: JSON.stringify(args) },
  { type: "done", stopReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 } },
];
const text = (s: string): LlmStreamEvent[] => [
  { type: "text", delta: s },
  { type: "done", stopReason: "stop", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } },
];

function harness(opts: { kind?: "native" | "coding"; documentTools?: unknown; script: LlmStreamEvent[][] }) {
  const state = { offered: [] as string[], toolResults: [] as string[], loaded: null as any };
  const agent = {
    id: "a1",
    name: "writer",
    kind: opts.kind ?? "native",
    systemPrompt: "Write docs.",
    model: "m",
    budgetUsd: 10,
    maxTurns: 10,
    ownerId: "p1",
    documentTools: opts.documentTools ?? null,
  };
  const runs = new Map<string, any>([
    [
      "run1",
      {
        id: "run1",
        agentId: "a1",
        status: "pending",
        trigger: "webhook",
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        error: null,
        startedAt: new Date(),
        finishedAt: null,
        finalText: null,
        turns: 0,
        parentRunId: null,
        taskOverride: null,
      },
    ],
  ]);
  const db: any = {
    agent: { findUnique: async ({ where }: any) => (where.id === agent.id ? agent : null) },
    run: {
      findUnique: async ({ where }: any) => runs.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }: any) => runs.get(where.id),
      updateMany: async ({ where, data }: any) => {
        const record = runs.get(where.id);
        if (!record || !where.status.in.includes(record.status)) return { count: 0 };
        runs.set(where.id, { ...record, ...data });
        return { count: 1 };
      },
      findMany: async () => [],
    },
    agentTool: { findMany: async () => [] },
    agentMcpServer: { findMany: async () => [], findUnique: async () => null },
    agentSecret: { findMany: async () => [] },
    budgetGroup: { findUnique: async () => null },
    agentSubAgent: { findMany: async () => [] },
    $queryRaw: async () => [{ usd: null }],
  };
  let turn = 0;
  const llm: LlmProvider = {
    async *stream(req) {
      if (turn === 0) state.offered = (req.tools ?? []).map((t) => t.name);
      for (const m of req.messages) if (m.role === "tool") state.toolResults.push(m.content);
      for (const event of opts.script[turn++] ?? []) yield event;
    },
    async countTokens() {
      return 10;
    },
    priceUsd: (_m, u) => (u.inputTokens + u.outputTokens) / 1000,
  };
  const providers = {
    llm,
    engine: new NativeEngine(),
    datastore: {} as Datastore,
    secrets: { keyId: () => "k" } as unknown as SecretCipher,
    memory: {} as AgentMemoryStore,
  };
  return { db: db as RunnerDb, state, providers };
}

const setting = (access: "read" | "write") => ({
  access,
  reviewers: ["p1"],
  finalApproverId: null,
  maxNewPerRun: 5,
  plans: [],
});
const docNames = (names: string[]) => names.filter((n) => n.startsWith("doc_"));

describe("doc_* built-ins in the native run loop", () => {
  it("offers all 9 tools for write, the 4 read tools for read, none when off", async () => {
    for (const [documentTools, expected] of [
      [setting("write"), ALL_NINE],
      [setting("read"), READ.length],
      [null, 0],
    ] as const) {
      const h = harness({ documentTools, script: [text("done")] });
      await executeRun("run1", h.providers, h.db);
      expect(docNames(h.state.offered)).toHaveLength(expected);
      if (documentTools?.access === "read") expect(docNames(h.state.offered)).toEqual(READ);
    }
  });

  it("offers no doc_* tools to a coding agent with a stored setting", async () => {
    const h = harness({ kind: "coding", documentTools: setting("write"), script: [text("done")] });
    await executeRun("run1", h.providers, h.db).catch(() => undefined);
    expect(docNames(h.state.offered)).toEqual([]);
  });

  it("dispatches a call to the handler with the run's ids and returns its result", async () => {
    handled.length = 0;
    const h = harness({
      documentTools: setting("write"),
      script: [toolCall("doc_create", { title: "t" }), text("done")],
    });
    const run = await executeRun("run1", h.providers, h.db);
    expect(run.status).toBe("succeeded");
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ name: "doc_create", ctx: { agentId: "a1", runId: "run1" } });
    expect(handled[0]?.ctx.cipher).toBe(h.providers.secrets);
    expect(h.state.toolResults.some((r) => r.includes('"id":"doc-1"'))).toBe(true);
  });

  it("lists the doc_* names as gateway built-ins for a sandboxed run, and serves a call", async () => {
    handled.length = 0;
    const loaded: any = {
      agentId: "a1",
      kind: "native",
      pricing: { entry: { inputPerMTok: 1, outputPerMTok: 1, efforts: [] } },
      documentToolsAccess: "read",
      agent: { systemPrompt: "s", model: "m", budgetUsd: 1, maxTurns: 1 },
      tools: [],
      toolsByName: {},
      mcpTools: [],
      issueProjectLinks: [],
      repositoryLinks: [],
      subAgentEdges: [],
    };
    const { documentToolDefsFor } = await import("./document-tools.js");
    loaded.tools = documentToolDefsFor(setting("read"));
    const h = harness({ documentTools: setting("read"), script: [] });
    const tools = createNativeRunTools({ db: h.db, providers: h.providers, runId: "run1", loaded } as any);
    const input = sandboxWorkerInput("run1", loaded, tools);
    expect(input.builtinTools).toEqual(READ);
    const handler = tools.builtinHandler("doc_list");
    expect(handler).toBeDefined();
    expect(JSON.parse(await handler!("{}"))).toMatchObject({ tool: "doc_list" });
    // No access pinned: not a built-in.
    const off = createNativeRunTools({
      db: h.db,
      providers: h.providers,
      runId: "run1",
      loaded: { ...loaded, documentToolsAccess: undefined },
    } as any);
    expect(off.builtinHandler("doc_list")).toBeUndefined();
  });
});
