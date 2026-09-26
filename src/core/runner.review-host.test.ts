import { describe, expect, it, vi } from "vitest";
import type { Datastore } from "../providers/datastore/types.js";
import type { AgentMemoryStore } from "../providers/memory/types.js";
import type { LlmProvider, LlmStreamEvent } from "../providers/llm/types.js";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import type { SecretCipher } from "../providers/secrets/types.js";
import { NativeEngine } from "./engine-native.js";
import { executeRun, type RunnerDb } from "./runner.js";

// End-to-end coverage of the repo_* built-ins inside a real NativeEngine run
// loop (scripted LLM, fake DB): offered only to linked agents when a review
// host is composed in, the run's control-plane check is injected into
// publishReview, and any check the run leaves open is closed at the end.

const SHA = "a".repeat(40);
const REPO = "chfields/knock-knock-jokes";

interface FakeLink {
  agentId: string;
  provider: string;
  repository: string;
  access: string;
  checkName: string | null;
  triggers: string[];
  authorizedVia: string | null;
}

interface FakeRunHostCheck {
  runId: string;
  provider: string;
  repository: string;
  checkId: string;
  headSha: string;
  prNumber: number | null;
  completedAt: Date | null;
}

interface HarnessState {
  toolNamesOfferedOnFirstCall: string[];
  agentRepositoryQueried: boolean;
  runHostCheck: FakeRunHostCheck | null;
}

const LINK: FakeLink = {
  agentId: "a1",
  provider: "github",
  repository: REPO,
  access: "write",
  checkName: "wardby review",
  triggers: ["pull_request"],
  authorizedVia: "grandfathered",
};
const OPEN_CHECK: FakeRunHostCheck = {
  runId: "run1",
  provider: "github",
  repository: REPO,
  checkId: "11",
  headSha: SHA,
  prNumber: 7,
  completedAt: null,
};

const toolCall = (name: string, args: unknown): LlmStreamEvent[] => [
  { type: "tool_call", id: "c1", name, argsJson: JSON.stringify(args) },
  { type: "done", stopReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 } },
];
const text = (s: string): LlmStreamEvent[] => [
  { type: "text", delta: s },
  { type: "done", stopReason: "stop", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } },
];

function fakeHost(): CodeReviewHost {
  return {
    provider: "github",
    repositoryPermission: vi.fn(async () => ({ level: "write" as const, login: "octo" })),
    readPullRequest: vi.fn(async () => ({ number: 7 }) as never),
    pullRequestHead: vi.fn(),
    readFile: vi.fn(async () => ({ kind: "not_found" as const, path: "x" })),
    listFiles: vi.fn(),
    publishReview: vi.fn(async () => ({
      published: true as const,
      reviewUrl: null,
      summaryCommentUrl: "https://x/5",
      checkId: "11",
      checkConclusion: "success" as const,
      inlineCount: 0,
      outsideDiffCount: 0,
      resolvedThreadIds: [],
      skippedThreadIds: [],
    })),
    comment: vi.fn(async () => ({ url: "https://x/c", id: "1" })),
    editComment: vi.fn(async () => undefined),
    acknowledge: vi.fn(),
    startCheck: vi.fn(),
    completeCheck: vi.fn(async () => undefined),
  };
}

function harness(opts: {
  links: FakeLink[];
  runHostCheck?: FakeRunHostCheck;
  script: LlmStreamEvent[][];
  ownerId?: string | null;
}) {
  const state: HarnessState = {
    toolNamesOfferedOnFirstCall: [],
    agentRepositoryQueried: false,
    runHostCheck: opts.runHostCheck ? { ...opts.runHostCheck } : null,
  };
  const agent = {
    id: "a1",
    name: "reviewer",
    systemPrompt: "Review PRs.",
    model: "m",
    budgetUsd: 10,
    maxTurns: 10,
    ownerId: opts.ownerId === undefined ? "p1" : opts.ownerId,
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
    budgetGroup: { findUnique: async () => null },
    agentSubAgent: { findMany: async () => [] },
    agentRepository: {
      findMany: async ({ where }: any) => {
        state.agentRepositoryQueried = true;
        return opts.links.filter((l) => l.agentId === where.agentId);
      },
      findUnique: async ({ where }: any) => {
        const key = where.agentId_provider_repository;
        const link = opts.links.find(
          (l) => l.agentId === key.agentId && l.provider === key.provider && l.repository === key.repository,
        );
        return link ? { ...link, agent: { ownerId: agent.ownerId } } : null;
      },
    },
    // No principal has a linked GitHub identity in this harness.
    hostIdentity: { findUnique: async () => null, updateMany: async () => ({ count: 0 }) },
    runHostCheck: {
      findUnique: async ({ where }: any) =>
        state.runHostCheck && state.runHostCheck.runId === where.runId ? { ...state.runHostCheck } : null,
      update: async ({ where, data }: any) => {
        if (!state.runHostCheck || state.runHostCheck.runId !== where.runId) throw new Error("no runHostCheck");
        state.runHostCheck = { ...state.runHostCheck, ...data };
        return state.runHostCheck;
      },
    },
  };

  let turn = 0;
  const llm: LlmProvider = {
    async *stream(req) {
      if (turn === 0) state.toolNamesOfferedOnFirstCall = (req.tools ?? []).map((t) => t.name);
      for (const event of opts.script[turn++] ?? []) yield event;
    },
    async countTokens() {
      return 10;
    },
    priceUsd(_model, usage) {
      return (usage.inputTokens + usage.outputTokens) / 1000;
    },
  };
  return { db: db as RunnerDb, state, llm };
}

function providers(llm: LlmProvider) {
  return {
    llm,
    engine: new NativeEngine(),
    datastore: {} as Datastore,
    secrets: {} as SecretCipher,
    memory: {} as AgentMemoryStore,
  };
}

describe("repo_* built-ins in the native run loop", () => {
  it("offers repo_* tools only to linked agents, injects the run's check, and closes nothing already completed", async () => {
    const host = fakeHost();
    const { db, state, llm } = harness({
      links: [LINK],
      runHostCheck: OPEN_CHECK,
      script: [
        toolCall("repo_publish_review", {
          repository: REPO,
          prNumber: 7,
          headSha: SHA,
          verdict: "APPROVE",
          summary: "ok",
          body: "fine",
        }),
        text("done"),
      ],
    });
    const run = await executeRun("run1", { ...providers(llm), reviewHosts: { github: host } }, db);
    expect(run.status).toBe("succeeded");
    expect(state.toolNamesOfferedOnFirstCall).toEqual(expect.arrayContaining(["repo_pr_read", "repo_publish_review"]));
    expect(vi.mocked(host.publishReview).mock.calls[0][1].checkId).toBe("11");
    expect(state.runHostCheck!.completedAt).toBeInstanceOf(Date);
    expect(host.completeCheck).not.toHaveBeenCalled();
  });

  it("closes the run's open check when the run ends without publishing", async () => {
    const host = fakeHost();
    const { db, state, llm } = harness({ links: [LINK], runHostCheck: OPEN_CHECK, script: [text("I give up")] });
    await executeRun("run1", { ...providers(llm), reviewHosts: { github: host } }, db);
    expect(host.completeCheck).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({ checkId: "11", conclusion: "neutral" }),
    );
    expect(state.runHostCheck!.completedAt).toBeInstanceOf(Date);
  });

  it("offers no repo_* tools and touches no new tables without reviewHosts", async () => {
    const { db, state, llm } = harness({ links: [LINK], script: [text("done")] });
    await executeRun("run1", providers(llm), db);
    expect(state.toolNamesOfferedOnFirstCall).not.toContain("repo_pr_read");
    expect(state.agentRepositoryQueried).toBe(false);
  });
});

describe("repo_* built-ins re-check repository authorization at every call", () => {
  const publish = toolCall("repo_publish_review", {
    repository: REPO,
    prNumber: 7,
    headSha: SHA,
    verdict: "APPROVE",
    summary: "ok",
    body: "fine",
  });

  it("refuses a host_permission link whose owner has no linked GitHub identity", async () => {
    const host = fakeHost();
    const { db, llm } = harness({
      links: [{ ...LINK, authorizedVia: "host_permission" }],
      script: [publish, text("done")],
    });
    const run = await executeRun("run1", { ...providers(llm), reviewHosts: { github: host } }, db);
    expect(run.status).toBe("succeeded");
    expect(host.publishReview).not.toHaveBeenCalled();
    expect(host.repositoryPermission).not.toHaveBeenCalled();
  });

  it("refuses every link, even grandfathered, once the agent has no owner", async () => {
    const host = fakeHost();
    const { db, llm } = harness({ links: [LINK], ownerId: null, script: [publish, text("done")] });
    await executeRun("run1", { ...providers(llm), reviewHosts: { github: host } }, db);
    expect(host.publishReview).not.toHaveBeenCalled();
  });

  it("refuses a link removed after the run loaded it", async () => {
    const host = fakeHost();
    const links = [LINK];
    const { db, llm } = harness({ links, script: [publish, text("done")] });
    const original = (db as any).agentRepository.findUnique;
    (db as any).agentRepository.findUnique = async () => null;
    await executeRun("run1", { ...providers(llm), reviewHosts: { github: host } }, db);
    expect(host.publishReview).not.toHaveBeenCalled();
    (db as any).agentRepository.findUnique = original;
  });
});
