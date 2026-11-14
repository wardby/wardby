/**
 * A coding run's repository set (#537) against real PostgreSQL: dispatch writes the
 * CodingRunRepository rows in the same transaction as the CodingRun, each extra authorized
 * through the repository-access gate before its ref is resolved. The executor is a fake; the gate
 * is the real one, with a fixed GitHub allowlist. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Executor } from "../providers/executor/types.js";
import { RepositoryRefUnreadableError, RepositorySetRefusedError } from "./coding-repository-set.js";
import { createPrismaClient } from "./db.js";
import { setLogLineFilter } from "./logger.js";
import { checkContinuation, ContinuationRefusedError, dispatchRun } from "./dispatch.js";
import { createRepoAccessGate } from "./repo-access.js";
import { claimDueRun, findDueCandidates } from "./scheduler.js";

const BASE_SHA = "c".repeat(40);
const MAIN_SHA = "d".repeat(40);
const FAKE_TOKEN = "ghs_FAKEtoken0123456789abcdefABCDEF";

describe.skipIf(!process.env.DATABASE_URL)("dispatchRun repository set (database)", () => {
  const db = createPrismaClient();
  const PREFIX = "drsdb-";
  const suffix = randomUUID().slice(0, 8);
  const owner = `${PREFIX}owner-${suffix}`;
  let counter = 0;
  /** The served GitHub accounts: `acme` only. */
  const gate = createRepoAccessGate({ db: {} as never, hosts: {}, trustedAccounts: async () => new Set(["acme"]) });

  function fakeExecutor(refFile: string | null = BASE_SHA) {
    const spies = {
      authorizeCodingRepository: vi.fn((input: Parameters<typeof gate.authorizeUse>[0]) => gate.authorizeUse(input)),
      readCodingRepositoryFile: vi.fn(async () => refFile),
      // `main` names MAIN_SHA; a SHA names itself; anything else does not exist.
      resolveCodingRepositoryRef: vi.fn(async ({ ref }: { ref: string }) =>
        ref === "main" ? MAIN_SHA : /^[0-9a-f]{40}$/.test(ref) ? ref : null,
      ),
    };
    const executor: Executor = { start: vi.fn(async () => {}), async stop() {}, ...spies };
    return { executor, spies };
  }

  /** A coding agent with read links `base` (ref file upstream-sync) and `upstream` (ref main), both in its default set. */
  async function codingAgent(links: { upstreamRepository?: string } = {}) {
    const agentId = `${PREFIX}agent-${suffix}-${++counter}`;
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "Sync things.",
        model: "gpt-5.6-luna",
        budgetUsd: 2,
        kind: "coding",
        ownerId: owner,
        codingProfile: {
          create: { provider: "codex", repository: "acme/fork", defaultTask: "Sync.", protectedPaths: [] },
        },
      },
    });
    const base = await db.agentRepository.create({
      data: {
        agentId,
        name: "base",
        provider: "github",
        repository: `acme/base-${suffix}-${counter}`,
        access: "read",
        refFromFile: "upstream-sync",
        inDefaultSet: true,
        authorizedVia: "admin",
        createdAt: new Date(1_000),
      },
    });
    const upstream = await db.agentRepository.create({
      data: {
        agentId,
        name: "upstream",
        provider: "github",
        repository: links.upstreamRepository ?? `acme/upstream-${suffix}-${counter}`,
        access: "read",
        ref: "main",
        inDefaultSet: true,
        authorizedVia: "admin",
        createdAt: new Date(2_000),
      },
    });
    return { agentId, base, upstream };
  }

  const rowsOf = (runId: string) => db.codingRunRepository.findMany({ where: { runId }, orderBy: { position: "asc" } });
  const runsOf = (agentId: string) => db.run.findMany({ where: { agentId } });

  async function cleanup(): Promise<void> {
    const agents = { agentId: { startsWith: PREFIX } };
    await db.run.deleteMany({ where: agents });
    await db.agent.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await db.principal.deleteMany({ where: { id: { startsWith: PREFIX } } });
  }

  beforeAll(async () => {
    await cleanup();
    await db.principal.create({ data: { id: owner, subject: owner } });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("writes the default set's rows, the file's ref resolved and the link's ref resolved", async () => {
    const { agentId, base, upstream } = await codingAgent();
    const { executor, spies } = fakeExecutor();
    const result = await dispatchRun({ db, executor, agentId, codingTask: "sync" });

    expect(spies.readCodingRepositoryFile).toHaveBeenCalledWith(
      expect.objectContaining({ repository: "acme/fork", baseRef: "main", path: "upstream-sync" }),
    );
    expect(await rowsOf(result!.run.id)).toEqual([
      expect.objectContaining({
        position: 0,
        name: "base",
        requestedRef: BASE_SHA,
        refFromFile: "upstream-sync",
        resolvedSha: BASE_SHA,
        access: "read",
        linkId: base.id,
        baseRef: null,
        headRef: null,
        viaRepositoryLink: true,
      }),
      expect.objectContaining({
        position: 1,
        name: "upstream",
        requestedRef: "main",
        refFromFile: null,
        resolvedSha: MAIN_SHA,
        linkId: upstream.id,
      }),
    ]);
  });

  it("writes no rows for repositories: []", async () => {
    const { agentId } = await codingAgent();
    const { executor, spies } = fakeExecutor();
    const result = await dispatchRun({ db, executor, agentId, codingTask: "sync", codingRepositories: [] });
    expect(await rowsOf(result!.run.id)).toEqual([]);
    expect(spies.resolveCodingRepositoryRef).not.toHaveBeenCalled();
  });

  it("refuses an unlisted name before any run exists", async () => {
    const { agentId } = await codingAgent();
    const { executor } = fakeExecutor();
    await expect(
      dispatchRun({ db, executor, agentId, codingTask: "sync", codingRepositories: ["nope"] }),
    ).rejects.toBeInstanceOf(RepositorySetRefusedError);
    expect(await runsOf(agentId)).toEqual([]);
  });

  it.each([FAKE_TOKEN, "sk-fake-secret-0123456789"])(
    "names a ref file by its path, never its content (%s), anywhere: error, run record, logs",
    async (secret) => {
      const { agentId } = await codingAgent();
      // A valid branch name that does not exist: the fake resolves it to null.
      const { executor } = fakeExecutor(`${secret}\n`);
      // Every dispatch log line (pino writes to fd 2, past any console or stream spy).
      const logged: string[] = [];
      setLogLineFilter((line) => {
        logged.push(line);
        return line;
      });
      for (const method of ["log", "info", "warn", "error", "debug"] as const) {
        vi.spyOn(console, method).mockImplementation(
          (...args: unknown[]) => void logged.push(args.map(String).join(" ")),
        );
      }

      let caught: unknown;
      try {
        await dispatchRun({ db, executor, agentId, codingTask: "sync" });
      } catch (err) {
        caught = err;
      } finally {
        setLogLineFilter((line) => line);
      }

      expect(caught).toBeInstanceOf(RepositoryRefUnreadableError);
      const err = caught as RepositoryRefUnreadableError;
      expect(err.message).toBe(
        'repository_ref_unreadable: the ref file upstream-sync for link "base" names a ref that does not exist.',
      );
      expect(await runsOf(agentId)).toEqual([]);
      const seen = [err.message, JSON.stringify(err), String(err.stack), ...logged].join("\n");
      expect(seen).not.toContain(secret);
    },
  );

  it("refuses a run whose host is unavailable as repository_ref_unreadable (unavailable), before any run exists", async () => {
    const { agentId } = await codingAgent();
    const { executor, spies } = fakeExecutor();
    spies.resolveCodingRepositoryRef.mockRejectedValue(new Error("github_api_unavailable"));
    const attempt = dispatchRun({ db, executor, agentId, codingTask: "sync" });
    await expect(attempt).rejects.toBeInstanceOf(RepositoryRefUnreadableError);
    await expect(attempt).rejects.toMatchObject({ reason: "unavailable" });
    expect(await runsOf(agentId)).toEqual([]);
  });

  it("refuses a read link outside the GitHub allowlist without resolving any ref", async () => {
    // Stamped admin: the allowlist is still a hard limit.
    const { agentId } = await codingAgent({ upstreamRepository: `outside-org/upstream-${suffix}` });
    const { executor, spies } = fakeExecutor();
    const result = await dispatchRun({ db, executor, agentId, codingTask: "sync" });

    expect(result!.run).toMatchObject({ status: "refused" });
    expect(result!.run.error).toMatch(/^repo_access_github_account_not_allowed: /);
    expect(spies.authorizeCodingRepository).toHaveBeenCalledWith(
      expect.objectContaining({ repository: `outside-org/upstream-${suffix}`, required: "read", ownerId: owner }),
    );
    expect(spies.resolveCodingRepositoryRef).not.toHaveBeenCalled();
    expect(spies.readCodingRepositoryFile).not.toHaveBeenCalledWith(expect.objectContaining({ path: "upstream-sync" }));
    expect(executor.start).not.toHaveBeenCalled();
    expect(await db.codingRun.findUnique({ where: { runId: result!.run.id } })).toBeNull();
  });

  it("copies a continuation's rows from its root, never resolving again", async () => {
    const { agentId } = await codingAgent();
    const { executor } = fakeExecutor();
    const root = await dispatchRun({ db, executor, agentId, codingTask: "sync" });
    await db.codingRun.update({
      where: { runId: root!.run.id },
      data: {
        result: {
          schemaVersion: 1,
          outcome: "pull_request_opened",
          repository: "acme/fork",
          baseRef: "main",
          headRef: `wardby/run-${root!.run.id}`,
          commitSha: "a".repeat(40),
          pullRequestUrl: "https://github.com/acme/fork/pull/1",
          pullRequestNumber: 1,
          summary: "Opened the PR",
          tests: [],
          usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        },
      },
    });

    const second = fakeExecutor();
    const continuation = await dispatchRun({
      db,
      executor: second.executor,
      agentId,
      codingTask: "again",
      continuesCodingRunId: root!.run.id,
    });

    const strip = (rows: Awaited<ReturnType<typeof rowsOf>>) =>
      rows.map(({ name, position, resolvedSha, requestedRef, refFromFile, linkId, access }) => ({
        name,
        position,
        resolvedSha,
        requestedRef,
        refFromFile,
        linkId,
        access,
      }));
    expect(strip(await rowsOf(continuation!.run.id))).toEqual(strip(await rowsOf(root!.run.id)));
    expect((await rowsOf(continuation!.run.id)).map((r) => r.name)).toEqual(["base", "upstream"]);
    expect(second.spies.resolveCodingRepositoryRef).not.toHaveBeenCalled();
    expect(second.spies.authorizeCodingRepository).not.toHaveBeenCalled();
  });

  /** A root run of `agentId` with a writable `tools` row (pull request `toolsPr`) and the default's `result`. */
  async function rootWithTools(agentId: string, defaultResult: "opened" | "no_changes", toolsPr = 3) {
    const root = await dispatchRun({ db, executor: fakeExecutor().executor, agentId, codingTask: "sync" });
    const runId = root!.run.id;
    const opened = (repository: string, number: number) => ({
      schemaVersion: 1,
      outcome: "pull_request_opened",
      repository,
      baseRef: "main",
      headRef: `wardby/run-${runId}`,
      commitSha: "a".repeat(40),
      pullRequestUrl: `https://github.com/${repository}/pull/${number}`,
      pullRequestNumber: number,
      summary: "Opened the PR",
      tests: [],
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    });
    await db.codingRun.update({
      where: { runId },
      data: {
        result:
          defaultResult === "opened"
            ? opened("acme/fork", 7)
            : {
                schemaVersion: 1,
                outcome: "no_changes",
                repository: "acme/fork",
                baseRef: "main",
                summary: "Nothing here",
                tests: [],
                usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
              },
      },
    });
    const tools = `acme/tools-${suffix}-${++counter}`;
    await db.codingRunRepository.create({
      data: {
        runId,
        position: 2,
        name: "tools",
        access: "write",
        provider: "github",
        repository: tools,
        resolvedSha: MAIN_SHA,
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        pullRequestNumber: toolsPr,
        mergeOrder: 2,
        result: opened(tools, toolsPr),
      },
    });
    return { runId, tools };
  }

  it("copies the root row's merge order onto a continuation's row; the pull request is the continuation's own to record", async () => {
    const { agentId } = await codingAgent();
    const { runId } = await rootWithTools(agentId, "opened");
    const continuation = await dispatchRun({
      db,
      executor: fakeExecutor().executor,
      agentId,
      codingTask: "again",
      continuesCodingRunId: runId,
    });
    const tools = await db.codingRunRepository.findUniqueOrThrow({
      where: { runId_name: { runId: continuation!.run.id, name: "tools" } },
      select: { mergeOrder: true, pullRequestNumber: true, result: true, markedReadyAt: true },
    });
    expect(tools).toEqual({ mergeOrder: 2, pullRequestNumber: null, result: null, markedReadyAt: null });
  });

  it("continues a root from one of its writable extras' pull requests (checkContinuation)", async () => {
    const { agentId } = await codingAgent();
    const { runId, tools } = await rootWithTools(agentId, "opened");
    expect(await checkContinuation(db, runId, tools, owner)).toEqual({
      ok: true,
      root: {
        runId,
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        pullRequestNumber: 3,
        repo: { kind: "extra", name: "tools", repository: tools, pullRequestNumber: 3 },
      },
    });
    expect(await checkContinuation(db, runId, "acme/fork")).toMatchObject({
      ok: true,
      root: { pullRequestNumber: 7, repo: { kind: "default" } },
    });
    // A read repository of the set, and one outside it, are still other repositories.
    const [base] = await rowsOf(runId);
    expect(await checkContinuation(db, runId, base.repository)).toEqual({ ok: false, reason: "other_repository" });
    expect(await checkContinuation(db, runId, "acme/elsewhere")).toEqual({ ok: false, reason: "other_repository" });
  });

  it("matches an extra's replacement pull request by its own number, not the oldest row of that repository", async () => {
    const { agentId } = await codingAgent();
    const { runId, tools } = await rootWithTools(agentId, "opened");
    // A follow-up replaced tools#3 (closed) with tools#4: recorded on the continuation's own row.
    const continuation = await dispatchRun({
      db,
      executor: fakeExecutor().executor,
      agentId,
      codingTask: "replace the tools pull request",
      continuesCodingRunId: runId,
    });
    const contId = continuation!.run.id;
    await db.codingRunRepository.update({
      where: { runId_name: { runId: contId, name: "tools" } },
      data: { pullRequestNumber: 4 },
    });
    const check = (number?: number) =>
      checkContinuation(db, contId, tools, owner, number === undefined ? undefined : { provider: "github", number });
    expect(await check(4)).toMatchObject({
      ok: true,
      root: { runId, pullRequestNumber: 4, repo: { kind: "extra", name: "tools", pullRequestNumber: 4 } },
    });
    expect(await check(3)).toMatchObject({ ok: true, root: { pullRequestNumber: 3 } });
    // Without the number, the oldest row of the repository answers: the caller would refuse #4 as another PR.
    expect(await check()).toMatchObject({ ok: true, root: { pullRequestNumber: 3 } });
    expect(await check(5)).toEqual({ ok: false, reason: "no_pull_request" });
    // The provider is part of the match.
    expect(await checkContinuation(db, contId, tools, owner, { provider: "bitbucket", number: 4 })).toEqual({
      ok: false,
      reason: "other_repository",
    });
  });

  it("dispatches a continuation of a root whose default repository opened no pull request but an extra did", async () => {
    const { agentId } = await codingAgent();
    const { runId } = await rootWithTools(agentId, "no_changes");
    expect(await checkContinuation(db, runId, "acme/fork")).toEqual({ ok: false, reason: "no_pull_request" });
    const continuation = await dispatchRun({
      db,
      executor: fakeExecutor().executor,
      agentId,
      codingTask: "retry the default",
      continuesCodingRunId: runId,
    });
    const row = await db.codingRun.findUnique({ where: { runId: continuation!.run.id } });
    expect(row).toMatchObject({ rootCodingRunId: runId, repository: "acme/fork", headRef: `wardby/run-${runId}` });
    expect((await rowsOf(continuation!.run.id)).map((r) => r.name)).toEqual(["base", "upstream", "tools"]);
  });

  it("refuses a continuation of a root that opened no pull request anywhere", async () => {
    const { agentId } = await codingAgent();
    const { runId } = await rootWithTools(agentId, "no_changes");
    await db.codingRunRepository.updateMany({ where: { runId }, data: { pullRequestNumber: null } });
    await expect(
      dispatchRun({ db, executor: fakeExecutor().executor, agentId, codingTask: "again", continuesCodingRunId: runId }),
    ).rejects.toEqual(new ContinuationRefusedError("no_pull_request"));
  });

  it("refuses a continuation whose workspace would be one of the root's extras", async () => {
    const { agentId } = await codingAgent();
    const { runId } = await rootWithTools(agentId, "opened");
    // The root's default is now a repository this agent does not list, and its row is the agent's default.
    await db.codingRun.update({ where: { runId }, data: { repository: `acme/gone-${suffix}` } });
    await db.codingRunRepository.updateMany({ where: { runId, name: "tools" }, data: { repository: "acme/fork" } });
    await expect(
      dispatchRun({ db, executor: fakeExecutor().executor, agentId, codingTask: "again", continuesCodingRunId: runId }),
    ).rejects.toEqual(new ContinuationRefusedError("other_repository"));
  });

  it("refuses repositories on a continuation, which always reuses its root's set, before any run exists", async () => {
    const { agentId } = await codingAgent();
    const { runId } = await rootWithTools(agentId, "opened");
    const before = (await runsOf(agentId)).length;
    await expect(
      dispatchRun({
        db,
        executor: fakeExecutor().executor,
        agentId,
        codingTask: "again",
        continuesCodingRunId: runId,
        codingRepositories: ["base"],
      }),
    ).rejects.toThrow(RepositorySetRefusedError);
    expect(await runsOf(agentId)).toHaveLength(before);
  });

  it("records a deferred run's rows unresolved, the file's ref left for the start", async () => {
    const { agentId } = await codingAgent();
    const { executor, spies } = fakeExecutor();
    const deferred: Executor = { ...executor, defersCodingResolution: true };
    const result = await dispatchRun({ db, executor: deferred, agentId, codingTask: "sync" });
    expect(await rowsOf(result!.run.id)).toEqual([
      expect.objectContaining({ name: "base", requestedRef: null, refFromFile: "upstream-sync", resolvedSha: null }),
      expect.objectContaining({ name: "upstream", requestedRef: "main", resolvedSha: null }),
    ]);
    expect(spies.authorizeCodingRepository).not.toHaveBeenCalled();
    expect(spies.resolveCodingRepositoryRef).not.toHaveBeenCalled();
  });

  it("refuses a stored ref file path outside the repository at dispatch, without reading it", async () => {
    const { agentId, base } = await codingAgent();
    // Link-time validation refuses this; a row written some other way is refused here too.
    await db.agentRepository.update({ where: { id: base.id }, data: { refFromFile: "../secrets" } });
    const { executor, spies } = fakeExecutor();
    const attempt = dispatchRun({ db, executor, agentId, codingTask: "sync" });
    await expect(attempt).rejects.toBeInstanceOf(RepositoryRefUnreadableError);
    await expect(attempt).rejects.toThrow(
      'repository_ref_unreadable: the ref file for link "base" is not a repository-relative file path.',
    );
    expect(spies.readCodingRepositoryFile).not.toHaveBeenCalledWith(expect.objectContaining({ path: "../secrets" }));
    expect(await runsOf(agentId)).toEqual([]);
  });

  describe("remote links and git history (#536)", () => {
    afterEach(async () => {
      await db.agent.updateMany({ where: { id: { startsWith: PREFIX } }, data: { scheduleEnabled: false } });
    });
    const NOW = new Date("2026-09-05T12:16:00.000Z");

    async function remoteAgent(history: { gitHistoryDepth: number | null; gitHistoryFull: boolean }) {
      const made = await codingAgent();
      await db.codingAgentProfile.update({ where: { agentId: made.agentId }, data: history });
      await db.agentRepository.update({ where: { id: made.upstream.id }, data: { asRemote: true } });
      return made;
    }

    it("refuses a remote link while history is off, before any run exists", async () => {
      const { agentId } = await remoteAgent({ gitHistoryDepth: null, gitHistoryFull: false });
      const { executor, spies } = fakeExecutor();
      await expect(dispatchRun({ db, executor, agentId, codingTask: "sync" })).rejects.toThrow(
        /^repository_remote_needs_history:/,
      );
      expect(await runsOf(agentId)).toEqual([]);
      expect(spies.resolveCodingRepositoryRef).not.toHaveBeenCalled();
    });

    it("records one refused run for a scheduled dispatch, and advances the schedule", async () => {
      const { agentId } = await remoteAgent({ gitHistoryDepth: null, gitHistoryFull: false });
      await db.agent.update({
        where: { id: agentId },
        data: { schedule: "*/15 * * * *", timezone: "UTC", scheduleEnabled: true },
      });
      const { executor } = fakeExecutor();
      const runId = await claimDueRun(db, executor, agentId, NOW);
      const run = await db.run.findUnique({ where: { id: runId! } });
      expect(run).toMatchObject({ status: "refused", trigger: "scheduled" });
      expect(run?.error).toMatch(/^repository_remote_needs_history: /);
      expect(await runsOf(agentId)).toHaveLength(1);
      expect(executor.start).not.toHaveBeenCalled();
    });

    it("refuses a remote link on another host than the default repository (repository_remote_invalid)", async () => {
      const { agentId } = await remoteAgent({ gitHistoryDepth: 10, gitHistoryFull: false });
      await db.agentRepository.create({
        data: {
          agentId,
          name: "localup",
          provider: "local",
          repository: "local:/srv/up",
          access: "read",
          ref: "main",
          asRemote: true,
          inDefaultSet: true,
          authorizedVia: "local_root",
          createdAt: new Date(3_000),
        },
      });
      await expect(dispatchRun({ db, executor: fakeExecutor().executor, agentId, codingTask: "sync" })).rejects.toThrow(
        /^repository_remote_invalid:/,
      );
      expect(await runsOf(agentId)).toEqual([]);
    });

    it.each([[{ gitHistoryDepth: 50, gitHistoryFull: false }], [{ gitHistoryDepth: null, gitHistoryFull: true }]])(
      "copies the history setting %j to the run and asRemote to the repository row",
      async (history) => {
        const { agentId } = await remoteAgent(history);
        const result = await dispatchRun({ db, executor: fakeExecutor().executor, agentId, codingTask: "sync" });
        const run = await db.codingRun.findUniqueOrThrow({ where: { runId: result!.run.id } });
        expect({ gitHistoryDepth: run.gitHistoryDepth, gitHistoryFull: run.gitHistoryFull }).toEqual(history);
        expect((await rowsOf(result!.run.id)).map((r) => [r.name, r.asRemote])).toEqual([
          ["base", false],
          ["upstream", true],
        ]);
      },
    );

    it("leaves history off on the run and rows as before when the setting is off and no link is remote", async () => {
      const { agentId } = await codingAgent();
      const result = await dispatchRun({ db, executor: fakeExecutor().executor, agentId, codingTask: "sync" });
      const run = await db.codingRun.findUniqueOrThrow({ where: { runId: result!.run.id } });
      expect(run).toMatchObject({ gitHistoryDepth: null, gitHistoryFull: false });
      expect((await rowsOf(result!.run.id)).every((r) => r.asRemote === false)).toBe(true);
    });

    it("keeps asRemote on a continuation's copied rows", async () => {
      const { agentId } = await remoteAgent({ gitHistoryDepth: 50, gitHistoryFull: false });
      const { runId } = await rootWithTools(agentId, "opened");
      await db.codingRunRepository.updateMany({ where: { runId, name: "upstream" }, data: { asRemote: true } });
      const continuation = await dispatchRun({
        db,
        executor: fakeExecutor().executor,
        agentId,
        codingTask: "again",
        continuesCodingRunId: runId,
      });
      expect((await rowsOf(continuation!.run.id)).map((r) => [r.name, r.asRemote])).toEqual([
        ["base", false],
        ["upstream", true],
        ["tools", false],
      ]);
    });
  });

  describe("a continuation's git history comes from its root run (#536, #537)", () => {
    it.each([
      ["history switched off", { gitHistoryDepth: null, gitHistoryFull: false }],
      ["history switched to full", { gitHistoryDepth: null, gitHistoryFull: true }],
    ])("keeps the root's depth when the profile has %s", async (_label, switched) => {
      const { agentId } = await codingAgent();
      await db.codingAgentProfile.update({
        where: { agentId },
        data: { gitHistoryDepth: 50, gitHistoryFull: false },
      });
      const { runId } = await rootWithTools(agentId, "opened");
      await db.codingRun.update({ where: { runId }, data: { gitHistoryDepth: 50, gitHistoryFull: false } });
      await db.codingRunRepository.updateMany({ where: { runId, name: "upstream" }, data: { asRemote: true } });
      await db.codingAgentProfile.update({ where: { agentId }, data: switched });
      const continuation = await dispatchRun({
        db,
        executor: fakeExecutor().executor,
        agentId,
        codingTask: "again",
        continuesCodingRunId: runId,
      });
      const run = await db.codingRun.findUniqueOrThrow({ where: { runId: continuation!.run.id } });
      expect(run).toMatchObject({ gitHistoryDepth: 50, gitHistoryFull: false });
      expect((await rowsOf(continuation!.run.id)).map((r) => [r.name, r.asRemote])).toEqual([
        ["base", false],
        ["upstream", true],
        ["tools", false],
      ]);
    });
  });

  describe("a scheduled dispatch (no caller waiting for the error)", () => {
    const NOW = new Date("2026-09-05T12:16:00.000Z");
    const WINDOW = new Date("2026-09-05T12:15:00.000Z");

    async function scheduledAgent(): Promise<string> {
      const { agentId } = await codingAgent();
      await db.agent.update({
        where: { id: agentId },
        data: { schedule: "*/15 * * * *", timezone: "UTC", scheduleEnabled: true },
      });
      return agentId;
    }

    afterEach(async () => {
      vi.unstubAllEnvs();
      // Other suites count enabled schedules in this shared database (and a live scheduler would fire them).
      await db.agent.updateMany({ where: { id: { startsWith: PREFIX } }, data: { scheduleEnabled: false } });
    });

    it("commits a missing ref file as one refused run and advances the schedule, so the next tick does not retry", async () => {
      const agentId = await scheduledAgent();
      const { executor, spies } = fakeExecutor(null);

      const runId = await claimDueRun(db, executor, agentId, NOW);

      expect(runId).not.toBeNull();
      const run = await db.run.findUnique({ where: { id: runId! }, include: { codingRun: true } });
      expect(run).toMatchObject({
        status: "refused",
        trigger: "scheduled",
        finishedAt: NOW,
        error:
          'repository_ref_unreadable: the ref file upstream-sync for link "base" does not exist at the default repository\'s base branch.',
      });
      expect(run?.codingRun).toBeNull();
      expect(await rowsOf(runId!)).toEqual([]);
      expect(executor.start).not.toHaveBeenCalled();
      expect((await db.agent.findUnique({ where: { id: agentId } }))?.lastScheduledAt).toEqual(WINDOW);

      expect(spies.readCodingRepositoryFile).toHaveBeenCalledTimes(1);
      // The next tick (10 s later, same window) finds the agent not due, so it never claims it or
      // calls the host again; a claim that raced past that check still creates nothing.
      const nextTick = new Date(NOW.getTime() + 10_000);
      expect((await findDueCandidates(db, nextTick)).map((a) => a.id)).not.toContain(agentId);
      expect(await claimDueRun(db, executor, agentId, nextTick)).toBeNull();
      expect(await runsOf(agentId)).toHaveLength(1);
    });

    it("commits an over-limit default set as a refused run and advances the schedule", async () => {
      const agentId = await scheduledAgent();
      vi.stubEnv("CODING_MAX_RUN_REPOSITORIES", "2");
      const { executor, spies } = fakeExecutor();

      const runId = await claimDueRun(db, executor, agentId, NOW);

      const run = await db.run.findUnique({ where: { id: runId! } });
      expect(run).toMatchObject({ status: "refused", trigger: "scheduled" });
      expect(run?.error).toMatch(/^repository_set_too_large: this run would have 3 repositories; the limit is 2/);
      expect(spies.readCodingRepositoryFile).not.toHaveBeenCalledWith(
        expect.objectContaining({ path: "upstream-sync" }),
      );
      expect((await db.agent.findUnique({ where: { id: agentId } }))?.lastScheduledAt).toEqual(WINDOW);
      expect(await claimDueRun(db, executor, agentId, NOW)).toBeNull();
    });

    it("commits an over-limit default set as a refused run when the dispatch is deferred too", async () => {
      const agentId = await scheduledAgent();
      vi.stubEnv("CODING_MAX_RUN_REPOSITORIES", "2");
      const { executor } = fakeExecutor();
      const deferred: Executor = { ...executor, defersCodingResolution: true };

      const runId = await claimDueRun(db, deferred, agentId, NOW);

      const run = await db.run.findUnique({ where: { id: runId! } });
      expect(run).toMatchObject({ status: "refused", trigger: "scheduled" });
      expect(run?.error).toMatch(/^repository_set_too_large: /);
      expect((await db.agent.findUnique({ where: { id: agentId } }))?.lastScheduledAt).toEqual(WINDOW);
    });

    it("commits an executor without extra-repository support as a refused run", async () => {
      const agentId = await scheduledAgent();
      const bare: Executor = { start: vi.fn(async () => {}), async stop() {} };

      const runId = await claimDueRun(db, bare, agentId, NOW);

      const run = await db.run.findUnique({ where: { id: runId! } });
      expect(run).toMatchObject({
        status: "refused",
        error: "coding_repositories_unsupported: this deployment cannot resolve extra repositories.",
      });
      expect((await db.agent.findUnique({ where: { id: agentId } }))?.lastScheduledAt).toEqual(WINDOW);
    });

    it.each([FAKE_TOKEN, "sk-fake-secret-0123456789"])(
      "never writes the ref file's content (%s) to the refused run or the logs",
      async (secret) => {
        const agentId = await scheduledAgent();
        // A valid branch name that does not exist: the fake resolves it to null.
        const { executor } = fakeExecutor(`${secret}\n`);
        const logged: string[] = [];
        setLogLineFilter((line) => {
          logged.push(line);
          return line;
        });
        for (const method of ["log", "info", "warn", "error", "debug"] as const) {
          vi.spyOn(console, method).mockImplementation(
            (...args: unknown[]) => void logged.push(args.map(String).join(" ")),
          );
        }
        let runId: string | null;
        try {
          runId = await claimDueRun(db, executor, agentId, NOW);
        } finally {
          setLogLineFilter((line) => line);
        }

        const run = await db.run.findUnique({ where: { id: runId! }, include: { codingRun: true } });
        expect(run).toMatchObject({
          status: "refused",
          error:
            'repository_ref_unreadable: the ref file upstream-sync for link "base" names a ref that does not exist.',
        });
        const events = await db.runBudgetEvent.findMany({ where: { runId: runId! } });
        const seen = [JSON.stringify(run), JSON.stringify(events), ...logged].join("\n");
        expect(seen).not.toContain(secret);
      },
    );

    it("still refuses a manual dispatch synchronously, with no run", async () => {
      const agentId = await scheduledAgent();
      const { executor } = fakeExecutor(null);
      await expect(dispatchRun({ db, executor, agentId, codingTask: "sync" })).rejects.toBeInstanceOf(
        RepositoryRefUnreadableError,
      );
      expect(await runsOf(agentId)).toEqual([]);
      expect((await db.agent.findUnique({ where: { id: agentId } }))?.lastScheduledAt).toBeNull();
    });
  });
});
