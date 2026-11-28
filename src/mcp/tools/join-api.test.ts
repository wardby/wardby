import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";
import { handleJoinApi, joinApiAction, type JoinApiDeps } from "./join-api.js";
import type { JoinApiAction, JoinLinkPayload } from "./join-link.js";

// Fake tokens only: base64url JSON, "signed" by a prefix this test checks.
const mint = async (payload: JoinLinkPayload) => `fake.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
const verify = async (token: string) => {
  if (!token.startsWith("fake.")) throw new Error("bad signature");
  return JSON.parse(Buffer.from(token.slice(5), "base64url").toString()) as unknown;
};

interface Step {
  seq: number;
  kind: string;
  fromPrincipalId: string | null;
  summary: string;
  detail: string | null;
}

function setup(
  opts: {
    grants?: FakeGrantSeed[];
    status?: string;
    triggeredById?: string | null;
    provider?: string;
    authUser?: { roles: string[]; status: string } | null;
  } = {},
) {
  const steps: Step[] = [];
  const stops: string[] = [];
  const run = {
    id: "r1",
    agentId: "a1",
    triggeredById: opts.triggeredById ?? null,
    status: opts.status ?? "running",
    costUsd: { toString: () => "0.012300" },
    turns: 3,
    startedAt: new Date("2026-11-28T10:00:00Z"),
    timeoutSec: null as number | null,
    error: null as string | null,
    agent: { kind: "coding" },
    stopRequestReason: null as string | null,
  };
  const db = {
    resourceGrant: fakeResourceGrants(opts.grants ?? []),
    authUser: {
      findUnique: async () => opts.authUser ?? null,
      findMany: async () => [{ principalId: "g", displayName: "Grace" }],
    },
    teamMember: { findMany: async () => [] },
    agent: {
      findUnique: async () => ({
        id: "a1",
        ownerId: "owner",
        name: "builder",
        model: "claude-haiku-4-5",
        budgetUsd: { toString: () => "0.5000" },
        maxTurns: 10,
        systemPrompt: "You are a careful builder.",
      }),
    },
    run: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === "r1" ? run : null),
      findUniqueOrThrow: async () => run,
      updateMany: async () => ({ count: 0 }),
      findMany: async () => [],
    },
    codingRun: {
      findUnique: async () => ({
        provider: opts.provider ?? "claude-code",
        workflowName: null,
        result: null,
        model: "claude-sonnet-5-5",
        repository: "your-org/your-repo",
        timeoutSec: 1800,
        maxTurns: 200,
        budgetBaseUsd: { toString: () => "1.0000" },
      }),
    },
    runStep: {
      findMany: async ({ where }: { where: { kind?: { in: string[] }; seq?: { gt: number } } }) =>
        steps
          .filter((s) => (where.kind ? where.kind.in.includes(s.kind) : true))
          .filter((s) => (where.seq ? s.seq > where.seq.gt : true))
          .map((s) => ({ ...s, at: new Date(0), tool: null, status: null, agentRef: null })),
    },
  } as unknown as JoinApiDeps["db"];
  const deps: JoinApiDeps = {
    verify,
    mint,
    audience: "http",
    db,
    recordJoin: async (_runId, step) => {
      const seq = steps.length + 1;
      steps.push({
        seq,
        kind: step.kind,
        fromPrincipalId: step.principalId,
        summary: step.text ?? step.kind,
        detail: step.text ?? null,
      });
      return { seq, text: step.text ?? "" };
    },
    executor: {
      stop: async (runId: string) => {
        stops.push(runId);
        run.status = "cancelled";
      },
      removeRetainedRounds: async () => 0,
    },
  };
  return { deps, steps, stops, run };
}

function fakeRes() {
  let status = 0;
  let body = "";
  const res = {
    writeHead(s: number) {
      status = s;
      return res;
    },
    end(text?: string) {
      body = text ?? "";
      return res;
    },
  } as unknown as ServerResponse;
  return { res, result: () => ({ status, json: body ? (JSON.parse(body) as Record<string, unknown>) : {} }) };
}

const payload = (over: Partial<JoinLinkPayload> = {}): JoinLinkPayload => ({
  kind: "run-join",
  runId: "r1",
  principalId: "g",
  aud: "http",
  exp: Date.now() + 60_000,
  ...over,
});

async function call(deps: JoinApiDeps, action: JoinApiAction, token: string | null, body: unknown = {}) {
  const { res, result } = fakeRes();
  await handleJoinApi({ method: "POST", action, token, body }, res, deps);
  return result();
}

const EXECUTE: FakeGrantSeed[] = [{ resourceType: "agent", resourceId: "a1", principalId: "g", level: "execute" }];

describe("join API", () => {
  it("joins, sends a message and an interrupt, reads steps and status, and leaves, renewing the token each time", async () => {
    const t = setup({ grants: EXECUTE });
    const token = await mint(payload());
    const joined = await call(t.deps, "join", token);
    expect(joined.status).toBe(200);
    expect(joined.json).toMatchObject({ joined: true, already: false });
    expect(typeof joined.json.token).toBe("string");
    expect((await call(t.deps, "send", token, { message: "check the tests" })).json).toMatchObject({ kind: "message" });
    expect((await call(t.deps, "send", token, { message: "stop", interrupt: true })).json).toMatchObject({
      kind: "interrupt",
    });
    const page = await call(t.deps, "steps", token, { after: 1 });
    expect((page.json.steps as { kind: string; detail?: string }[]).map((s) => [s.kind, s.detail])).toEqual([
      ["message", "check the tests"],
      ["interrupt", "stop"],
    ]);
    const status = await call(t.deps, "status", token);
    expect(status.json).toMatchObject({ status: "running", costUsd: "0.012300", outcome: null });
    expect((await call(t.deps, "leave", token)).json).toMatchObject({ wasJoined: true });
    expect(t.steps.map((s) => s.kind)).toEqual(["join", "message", "interrupt", "leave"]);
  });

  it("stops the run through stopRun", async () => {
    const t = setup({ grants: EXECUTE });
    const stopped = await call(t.deps, "stop", await mint(payload()));
    expect(stopped.status).toBe(200);
    expect(stopped.json).toMatchObject({ status: "cancelled", stopRequested: true });
    expect(t.stops).toEqual(["r1"]);
  });

  it.each([
    ["no token", null],
    ["a forged token", "forged.abc"],
    ["an expired session", "expired"],
    ["a stdio link on the HTTP host", "stdio"],
    ["another kind of link", "kind"],
  ])("refuses %s as link_invalid, naming nothing", async (_name, which) => {
    const t = setup({ grants: EXECUTE });
    const token =
      which === null
        ? null
        : which === "expired"
          ? await mint(payload({ exp: Date.now() - 1 }))
          : which === "stdio"
            ? await mint(payload({ aud: "stdio" }))
            : which === "kind"
              ? `fake.${Buffer.from(JSON.stringify({ ...payload(), kind: "run-transcript" })).toString("base64url")}`
              : which;
    const answer = await call(t.deps, "join", token);
    expect(answer).toEqual({ status: 401, json: { error: "link_invalid" } });
    expect(t.steps).toEqual([]);
  });

  it("lets an owner-all admin join while their role still grants owner:all, and not once it is removed", async () => {
    const admin = setup({ grants: [], authUser: { roles: ["wardby_owner"], status: "enabled" } });
    const token = await mint(payload({ ownerAll: true, roles: ["wardby_owner"] }));
    expect((await call(admin.deps, "join", token)).status).toBe(200);
    // The role is read live from AuthUser: removed there, the same link no longer reaches the run.
    const demoted = setup({ grants: [], authUser: { roles: [], status: "enabled" } });
    expect((await call(demoted.deps, "join", token)).status).toBe(404);
    const disabled = setup({ grants: [], authUser: { roles: ["wardby_owner"], status: "disabled" } });
    expect((await call(disabled.deps, "join", token)).status).toBe(404);
  });

  it("uses the roles recorded in an owner-all link when the principal has no AuthUser (a delegating IdP)", async () => {
    const t = setup({ grants: [], authUser: null });
    expect((await call(t.deps, "join", await mint(payload({ ownerAll: true, roles: ["wardby_owner"] })))).status).toBe(
      200,
    );
    expect((await call(t.deps, "status", await mint(payload({ ownerAll: true, roles: [] })))).status).toBe(404);
  });

  it("checks access on every call: a principal who lost execute gets not found, and nothing is recorded", async () => {
    const t = setup({ grants: [] });
    const answer = await call(t.deps, "join", await mint(payload()));
    expect(answer).toEqual({ status: 404, json: { error: "not_found" } });
    expect(t.steps).toEqual([]);
  });

  it("refuses a triggerer whose access dropped to read as insufficient_access", async () => {
    const t = setup({
      triggeredById: "g",
      grants: [{ resourceType: "agent", resourceId: "a1", principalId: "g", level: "read" }],
    });
    expect(await call(t.deps, "join", await mint(payload()))).toEqual({
      status: 403,
      json: { error: "insufficient_access" },
    });
  });

  it("answers the join refusals with their codes", async () => {
    const done = setup({ grants: EXECUTE, status: "succeeded" });
    expect((await call(done.deps, "join", await mint(payload()))).json).toMatchObject({ error: "run_not_running" });
    const codex = setup({ grants: EXECUTE, provider: "codex" });
    expect((await call(codex.deps, "join", await mint(payload()))).json).toMatchObject({ error: "join_not_supported" });
    const notJoined = setup({ grants: EXECUTE });
    expect((await call(notJoined.deps, "send", await mint(payload()), { message: "hi" })).json).toMatchObject({
      error: "run_not_joined",
    });
  });

  it("refuses a malformed body and any method but POST", async () => {
    const t = setup({ grants: EXECUTE });
    const token = await mint(payload());
    expect((await call(t.deps, "steps", token, { after: -1 })).json).toEqual({ error: "invalid_request" });
    expect((await call(t.deps, "send", token, { message: "" })).json).toEqual({ error: "invalid_request" });
    const { res, result } = fakeRes();
    await handleJoinApi({ method: "GET", action: "status", token, body: undefined }, res, t.deps);
    expect(result().status).toBe(405);
  });

  it("shows the agent and the run with /agent, and the system prompt with /prompt, to someone with execute", async () => {
    const t = setup({ grants: EXECUTE, triggeredById: "g" });
    await call(t.deps, "join", await mint(payload()));
    const agent = await call(t.deps, "agent", await mint(payload()));
    expect(agent.status).toBe(200);
    expect(agent.json).toMatchObject({
      agent: {
        id: "a1",
        name: "builder",
        kind: "claude-code",
        model: "claude-sonnet-5-5",
        repository: "your-org/your-repo",
      },
      run: {
        status: "running",
        startedBy: "you",
        costUsd: "0.012300",
        budgetUsd: "1.0000",
        turns: 3,
        maxTurns: 200,
        timeoutSec: 1800,
        deadlineAt: "2026-11-28T10:30:00.000Z",
        joined: ["you"],
      },
    });
    const prompt = await call(t.deps, "prompt", await mint(payload()));
    expect(prompt.json).toMatchObject({ systemPrompt: "You are a careful builder." });
  });

  it("refuses /agent and /prompt without execute on the agent", async () => {
    const t = setup({
      grants: [{ resourceType: "agent", resourceId: "a1", principalId: "g", level: "read" }],
      triggeredById: "g",
    });
    expect((await call(t.deps, "agent", await mint(payload()))).status).toBe(403);
    expect((await call(t.deps, "prompt", await mint(payload()))).status).toBe(403);
    const none = setup({ grants: [] });
    expect((await call(none.deps, "prompt", await mint(payload()))).json).toEqual({ error: "not_found" });
  });

  it("maps paths to actions", () => {
    expect(joinApiAction("/join/api/agent")).toBe("agent");
    expect(joinApiAction("/join/api/prompt")).toBe("prompt");
    expect(joinApiAction("/join/api/send")).toBe("send");
    expect(joinApiAction("/join/api/nope")).toBeUndefined();
    expect(joinApiAction("/join")).toBeUndefined();
  });
});
