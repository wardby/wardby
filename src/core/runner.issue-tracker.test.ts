import { describe, expect, it, vi } from "vitest";
import type { Datastore } from "../providers/datastore/types.js";
import type { IssueTracker } from "../providers/issue-tracker/types.js";
import type { AgentMemoryStore } from "../providers/memory/types.js";
import type { LlmProvider, LlmStreamEvent } from "../providers/llm/types.js";
import type { SecretCipher } from "../providers/secrets/types.js";
import { NativeEngine } from "./engine-native.js";
import { executeRun, type RunnerDb } from "./runner.js";

// End-to-end coverage of the jira_* built-ins inside a real NativeEngine run
// loop (scripted LLM, fake DB): offered only to agents with a Jira project
// link when a tracker is composed in, dispatched to the tracker with the
// live link, and the run's issue status comment is completed at the end.

interface FakeLink {
  agentId: string;
  provider: string;
  projectKey: string;
  access: string;
  commentVisibilityRole: string | null;
  allowedTransitions?: string[];
  writableFields?: string[];
  allowedLinkTypes?: string[];
  creatableIssueTypes?: string[];
  maxNewIssuesPerRun?: number | null;
}

interface FakeStatus {
  runId: string;
  provider: string;
  issueKey: string;
  commentId: string | null;
  visibilityRole: string | null;
  completedAt: Date | null;
}

const LINK: FakeLink = {
  agentId: "a1",
  provider: "jira",
  projectKey: "PROJ",
  access: "write",
  commentVisibilityRole: "Developers",
};

const toolCall = (name: string, args: unknown): LlmStreamEvent[] => [
  { type: "tool_call", id: "c1", name, argsJson: JSON.stringify(args) },
  { type: "done", stopReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 } },
];
const text = (s: string): LlmStreamEvent[] => [
  { type: "text", delta: s },
  { type: "done", stopReason: "stop", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } },
];

function fakeTracker(): IssueTracker {
  return {
    provider: "jira",
    botAccountId: vi.fn(async () => "bot-1"),
    createMeta: vi.fn(),
    fieldMeta: vi.fn(),
    createIssue: vi.fn(),
    readAttachmentText: vi.fn(),
    identity: vi.fn(async () => ({ accountId: "bot-1", displayName: "wardby", accountType: "app" })),
    transitions: vi.fn(),
    transitionTo: vi.fn(),
    editableFields: vi.fn(),
    editFields: vi.fn(),
    linkTypes: vi.fn(),
    linkIssues: vi.fn(),
    addRemoteLink: vi.fn(),
    getProperty: vi.fn(),
    setProperty: vi.fn(),
    getIssue: vi.fn(),
    issueProject: vi.fn(async (key: string) => key.slice(0, key.lastIndexOf("-"))),
    snapshotIssue: vi.fn(async (key: string) => ({
      key,
      url: `https://example.test/browse/${key}`,
      scopeKey: key.slice(0, key.lastIndexOf("-")),
    })),
    search: vi.fn(),
    matchesJql: vi.fn(),
    comment: vi.fn(async () => ({ id: "10001", url: "https://your-site.atlassian.net/browse/PROJ-1" })),
    editComment: vi.fn(async () => undefined),
    readComment: vi.fn(),
    issueUrl: (k: string) => `https://your-site.atlassian.net/browse/${k}`,
  };
}

function harness(opts: {
  links: FakeLink[];
  status?: FakeStatus;
  script: LlmStreamEvent[][];
  defect?: { projectKey: string; issueType: string };
  llmThrows?: string;
}) {
  const state = {
    toolNamesOfferedOnFirstCall: [] as string[],
    toolResults: [] as string[],
    agentIssueProjectQueried: false,
    links: opts.links,
    status: opts.status ? { ...opts.status } : null,
    fingerprints: [] as any[],
  };
  const agent = {
    id: "a1",
    name: "triager",
    systemPrompt: "Triage issues.",
    model: "m",
    budgetUsd: 10,
    maxTurns: 10,
    ownerId: "p1",
    defectProjectKey: opts.defect?.projectKey ?? null,
    defectIssueType: opts.defect?.issueType ?? null,
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
    agentSecret: { findMany: async () => [] },
    budgetGroup: { findUnique: async () => null },
    agentSubAgent: { findMany: async () => [] },
    agentIssueProject: {
      findMany: async ({ where }: any) => {
        state.agentIssueProjectQueried = true;
        return state.links.filter((l) => l.agentId === where.agentId);
      },
      findUnique: async ({ where }: any) => {
        const key = where.agentId_provider_projectKey;
        return (
          state.links.find(
            (l) => l.agentId === key.agentId && l.provider === key.provider && l.projectKey === key.projectKey,
          ) ?? null
        );
      },
    },
    // Just enough of a transaction for issue-dedupe's fileIssue (advisory lock + fingerprint rows).
    $transaction: async (fn: any) =>
      fn({
        $executeRaw: async () => 0,
        issueFingerprint: {
          findFirst: async () => null,
          create: async ({ data }: any) => {
            state.fingerprints.push(data);
            return data;
          },
        },
      }),
    $queryRaw: async () => [{ usd: null }],
    runIssueStatus: {
      findUnique: async ({ where }: any) =>
        state.status && state.status.runId === where.runId ? { ...state.status } : null,
      update: async ({ where, data }: any) => {
        if (!state.status || state.status.runId !== where.runId) throw new Error("no runIssueStatus");
        state.status = { ...state.status, ...data };
        return state.status;
      },
      updateMany: async ({ where, data }: any) => {
        if (!state.status || state.status.runId !== where.runId) return { count: 0 };
        if (state.status.completedAt !== where.completedAt) return { count: 0 };
        state.status = { ...state.status, ...data };
        return { count: 1 };
      },
    },
  };

  let turn = 0;
  const llm: LlmProvider = {
    async *stream(req) {
      if (turn === 0) state.toolNamesOfferedOnFirstCall = (req.tools ?? []).map((t) => t.name);
      if (opts.llmThrows) throw new Error(opts.llmThrows);
      for (const m of req.messages) if (m.role === "tool") state.toolResults.push(m.content);
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

const JIRA_TOOLS = [
  "jira_get_issue",
  "jira_search",
  "jira_comment",
  "jira_edit_own_comment",
  "jira_list_transitions",
  "jira_transition",
  "jira_update_fields",
  "jira_link_issues",
  "jira_get_property",
  "jira_set_property",
  "jira_create_issue",
  "jira_read_attachment",
];

describe("jira_* built-ins in the native run loop", () => {
  it("offers the jira_* tools to a linked agent and posts a comment through the tracker", async () => {
    const tracker = fakeTracker();
    const { db, state, llm } = harness({
      links: [LINK],
      script: [toolCall("jira_comment", { issueKey: "PROJ-1", body: "On it." }), text("done")],
    });
    const run = await executeRun("run1", { ...providers(llm), issueTrackers: { jira: tracker } }, db);
    expect(run.status).toBe("succeeded");
    expect(state.toolNamesOfferedOnFirstCall).toEqual(expect.arrayContaining(JIRA_TOOLS));
    expect(tracker.comment).toHaveBeenCalledWith("PROJ-1", {
      markdown: "On it.\n\n_wardby agent a1_",
      visibilityRole: "Developers",
      issueKeyProjects: ["PROJ"],
    });
    expect(state.toolResults.some((r) => r.includes('"id":"10001"'))).toBe(true);
  });

  it("offers no jira_* tools to an agent without a link", async () => {
    const { db, state, llm } = harness({ links: [], script: [text("done")] });
    await executeRun("run1", { ...providers(llm), issueTrackers: { jira: fakeTracker() } }, db);
    expect(state.agentIssueProjectQueried).toBe(true);
    for (const name of JIRA_TOOLS) expect(state.toolNamesOfferedOnFirstCall).not.toContain(name);
  });

  it("offers no jira_* tools and touches no Jira tables without a configured tracker", async () => {
    const { db, state, llm } = harness({ links: [LINK], script: [text("done")] });
    await executeRun("run1", { ...providers(llm), issueTrackers: {} }, db);
    expect(state.toolNamesOfferedOnFirstCall).not.toContain("jira_comment");
    expect(state.agentIssueProjectQueried).toBe(false);
  });

  it("refuses a call once the project was unlinked after the run loaded it", async () => {
    const tracker = fakeTracker();
    const { db, state, llm } = harness({
      links: [LINK],
      script: [toolCall("jira_comment", { issueKey: "PROJ-1", body: "On it." }), text("done")],
    });
    const findMany = (db as any).agentIssueProject.findMany;
    (db as any).agentIssueProject.findMany = async (args: any) => {
      const rows = await findMany(args);
      state.links = [];
      return rows;
    };
    await executeRun("run1", { ...providers(llm), issueTrackers: { jira: tracker } }, db);
    expect(tracker.comment).not.toHaveBeenCalled();
    expect(state.toolResults.some((r) => r.includes("project_not_linked"))).toBe(true);
  });

  it("transitions through the tracker when the live link allowlists the target", async () => {
    const tracker = fakeTracker();
    vi.mocked(tracker.transitionTo).mockResolvedValue({ transitionId: "21", toStatus: "Done" });
    const { db, state, llm } = harness({
      links: [{ ...LINK, allowedTransitions: ["Done"] }],
      script: [toolCall("jira_transition", { issueKey: "PROJ-1", toStatus: "Done" }), text("done")],
    });
    await executeRun("run1", { ...providers(llm), issueTrackers: { jira: tracker } }, db);
    expect(tracker.transitionTo).toHaveBeenCalledWith("PROJ-1", "Done");
    expect(state.toolResults.some((r) => r.includes('"toStatus":"Done"'))).toBe(true);
  });

  it("links issues through the tracker when the live link allowlists the type", async () => {
    const tracker = fakeTracker();
    vi.mocked(tracker.linkTypes).mockResolvedValue([
      { name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
    ]);
    const { db, state, llm } = harness({
      links: [{ ...LINK, allowedLinkTypes: ["Duplicate"] }],
      script: [
        toolCall("jira_link_issues", { type: "duplicate", inwardIssue: "PROJ-2", outwardIssue: "PROJ-1" }),
        text("done"),
      ],
    });
    await executeRun("run1", { ...providers(llm), issueTrackers: { jira: tracker } }, db);
    expect(tracker.linkIssues).toHaveBeenCalledWith({ type: "Duplicate", inwardKey: "PROJ-2", outwardKey: "PROJ-1" });
    expect(state.toolResults.some((r) => r.includes('"type":"Duplicate"'))).toBe(true);
  });

  it("fails closed for a link row without allowlists", async () => {
    const tracker = fakeTracker();
    const { db, state, llm } = harness({
      links: [LINK],
      script: [
        toolCall("jira_transition", { issueKey: "PROJ-1", toStatus: "Done" }),
        toolCall("jira_update_fields", { issueKey: "PROJ-1", fields: { labels: ["x"] } }),
        toolCall("jira_link_issues", { type: "Blocks", inwardIssue: "PROJ-2", outwardIssue: "PROJ-1" }),
        text("done"),
      ],
    });
    await executeRun("run1", { ...providers(llm), issueTrackers: { jira: tracker } }, db);
    expect(tracker.transitionTo).not.toHaveBeenCalled();
    expect(tracker.editFields).not.toHaveBeenCalled();
    expect(tracker.linkIssues).not.toHaveBeenCalled();
    expect(state.toolResults.some((r) => r.includes("link_type_not_allowed"))).toBe(true);
    expect(state.toolResults.some((r) => r.includes("transition_not_allowed"))).toBe(true);
    expect(state.toolResults.some((r) => r.includes("field_not_allowed"))).toBe(true);
  });

  it("creates issues with the run id, capped per run, counting this run's recorded fingerprint creates", async () => {
    const tracker = fakeTracker();
    vi.mocked(tracker.createIssue).mockResolvedValue({
      key: "PROJ-9",
      url: "https://your-site.atlassian.net/browse/PROJ-9",
    });
    const args = { projectKey: "PROJ", issueType: "Bug", summary: "S", description: "D" };
    const { db, state, llm } = harness({
      links: [{ ...LINK, creatableIssueTypes: ["Bug"], maxNewIssuesPerRun: 2 }],
      script: [toolCall("jira_create_issue", args), toolCall("jira_create_issue", args), text("done")],
    });
    const count = vi.fn(async (_args: any) => 1);
    (db as any).issueFingerprint = { count };
    await executeRun("run1", { ...providers(llm), issueTrackers: { jira: tracker } }, db);
    expect(tracker.createIssue).toHaveBeenCalledTimes(1);
    expect(tracker.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ projectKey: "PROJ", properties: { "wardby.a1.created": { runId: "run1" } } }),
    );
    expect(count).toHaveBeenCalledWith({
      where: { createdByRunId: "run1", issueProvider: "jira", projectKey: "PROJ" },
    });
    expect(state.toolResults.some((r) => r.includes('"outcome":"created"'))).toBe(true);
    expect(state.toolResults.some((r) => r.includes("issue_cap_reached"))).toBe(true);
  });

  it("refuses jira_create_issue for a link row without creatableIssueTypes", async () => {
    const tracker = fakeTracker();
    const { db, state, llm } = harness({
      links: [LINK],
      script: [
        toolCall("jira_create_issue", { projectKey: "PROJ", issueType: "Bug", summary: "S", description: "D" }),
        text("done"),
      ],
    });
    await executeRun("run1", { ...providers(llm), issueTrackers: { jira: tracker } }, db);
    expect(tracker.createIssue).not.toHaveBeenCalled();
    expect(state.toolResults.some((r) => r.includes("issue_type_not_allowed"))).toBe(true);
  });

  it("completes the run's issue status comment with the outcome", async () => {
    const tracker = fakeTracker();
    const { db, state, llm } = harness({
      links: [LINK],
      status: {
        runId: "run1",
        provider: "jira",
        issueKey: "PROJ-1",
        commentId: "900",
        visibilityRole: null,
        completedAt: null,
      },
      script: [text("Triaged.")],
    });
    await executeRun("run1", { ...providers(llm), issueTrackers: { jira: tracker } }, db);
    expect(tracker.editComment).toHaveBeenCalledWith("PROJ-1", "900", {
      markdown: expect.stringContaining("Triaged."),
      issueKeyProjects: ["PROJ"],
    });
    expect(state.status!.completedAt).toBeInstanceOf(Date);
  });
});

describe("self-defects at run finalization", () => {
  const DEFECT = { projectKey: "PROJ", issueType: "Bug" };
  const WRITE_LINK: FakeLink = { ...LINK, creatableIssueTypes: ["Bug"] };

  it("files a defect when a run of an opted-in agent fails, without the error text", async () => {
    const tracker = fakeTracker();
    vi.mocked(tracker.createIssue).mockResolvedValue({
      id: "10100",
      key: "PROJ-9",
      url: "https://your-site.atlassian.net/browse/PROJ-9",
    } as any);
    const { db, state, llm } = harness({
      links: [WRITE_LINK],
      script: [],
      defect: DEFECT,
      llmThrows: "provider_down: secret internals",
    });
    const run = await executeRun("run1", { ...providers(llm), issueTrackers: { jira: tracker } }, db);
    expect(run.status).toBe("failed");
    expect(tracker.createIssue).toHaveBeenCalledTimes(1);
    const input = vi.mocked(tracker.createIssue).mock.calls[0][0];
    expect(input).toMatchObject({ projectKey: "PROJ", issueType: "Bug" });
    expect(input.summary).toMatch(/^wardby agent "triager": failed/);
    expect(JSON.stringify(input)).not.toContain("secret internals");
    expect(state.fingerprints).toHaveLength(1);
    expect(state.fingerprints[0]).toMatchObject({ issueKey: "PROJ-9", agentId: "a1", createdByRunId: "run1" });
  });

  it("files nothing when the run succeeds", async () => {
    const tracker = fakeTracker();
    const { db, llm } = harness({ links: [WRITE_LINK], script: [text("done")], defect: DEFECT });
    const run = await executeRun("run1", { ...providers(llm), issueTrackers: { jira: tracker } }, db);
    expect(run.status).toBe("succeeded");
    expect(tracker.createIssue).not.toHaveBeenCalled();
  });
});

describe("posting built-ins mask the agent's attached secret values", () => {
  const FAKE = "fake-secret-value-1234";
  const withSecret = (db: RunnerDb, opts: { unreadable?: boolean } = {}) => {
    (db as any).agentSecret.findMany = async () => [{ boundName: "JIRA_TOKEN" }];
    (db as any).$queryRaw = async () => [{ usd: null, ciphertext: "ct", broker: null }];
    return {
      ...({} as SecretCipher),
      keyId: () => "k",
      encrypt: async (s: string) => s,
      decrypt: async () => {
        if (opts.unreadable) throw new Error(`decrypt failed for ${FAKE}`);
        return FAKE;
      },
    } as SecretCipher;
  };

  it("masks the value in a comment before the tracker sees it", async () => {
    const tracker = fakeTracker();
    const { db, state, llm } = harness({
      links: [LINK],
      script: [toolCall("jira_comment", { issueKey: "PROJ-1", body: `the token is ${FAKE}` }), text("done")],
    });
    const secrets = withSecret(db);
    await executeRun("run1", { ...providers(llm), secrets, issueTrackers: { jira: tracker } }, db);
    const sent = JSON.stringify(vi.mocked(tracker.comment).mock.calls);
    expect(sent).toContain("the token is [REDACTED]");
    expect(sent).not.toContain(FAKE);
    expect(state.toolResults.join("")).not.toContain(FAKE);
  });

  it("refuses the call and never reaches the tracker when the secrets cannot be read", async () => {
    const tracker = fakeTracker();
    const { db, state, llm } = harness({
      links: [LINK],
      script: [toolCall("jira_comment", { issueKey: "PROJ-1", body: `the token is ${FAKE}` }), text("done")],
    });
    const secrets = withSecret(db, { unreadable: true });
    await executeRun("run1", { ...providers(llm), secrets, issueTrackers: { jira: tracker } }, db);
    expect(tracker.comment).not.toHaveBeenCalled();
    const result = state.toolResults.join("");
    expect(result).toContain("secret_check_unavailable");
    expect(result).toContain("The agent's secrets could not be read to check this value; try again.");
    expect(result).not.toContain(FAKE);
  });

  it("leaves a read tool's arguments untouched and does not read the secrets", async () => {
    const tracker = fakeTracker();

    const { db, state, llm } = harness({
      links: [LINK],
      script: [toolCall("jira_list_transitions", { issueKey: "PROJ-1" }), text("done")],
    });
    const secrets = withSecret(db, { unreadable: true });
    const run = await executeRun("run1", { ...providers(llm), secrets, issueTrackers: { jira: tracker } }, db);
    expect(run.status).toBe("succeeded");
    expect(state.toolResults.join("")).not.toContain("secret_check_unavailable");
    expect(state.toolResults.join("")).toContain("transition_not_allowed");
  });
});
