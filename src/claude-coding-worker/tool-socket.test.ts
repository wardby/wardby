import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUDGET_MEASURE_TIMEOUT_MS, DEFAULT_TIMEOUTS } from "../coding-worker/dependency-cache.mjs";
import {
  assertToolRunnerReachable,
  callGitCheck,
  callPrepareDependencies,
  callResultBundle,
  GIT_CHECK_TOOL,
  RESULT_BUNDLE_TOOL,
  PREPARE_DEPENDENCIES_TIMEOUT_MS,
  PREPARE_DEPENDENCIES_TOOL,
  prepareDependenciesTimeoutMs,
} from "./tool-socket.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function socketDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wardby-tool-socket-"));
  roots.push(root);
  return root;
}

describe("assertToolRunnerReachable", () => {
  it("resolves when the tool runner is listening", async () => {
    const path = join(await socketDir(), "runner.sock");
    const server = createServer((socket) => socket.end());
    servers.push(server);
    await new Promise<void>((done) => server.listen(path, done));
    await expect(assertToolRunnerReachable(path)).resolves.toBeUndefined();
  });

  it("fails by name when the socket is absent", async () => {
    const path = join(await socketDir(), "runner.sock");
    await expect(assertToolRunnerReachable(path)).rejects.toThrow("worker_tool_runner_unreachable");
  });
});

/** A newline-delimited JSON-RPC server, framed like the tool runner's MCP stdio transport. */
async function fakeRunner(answer: (message: { id?: number; method: string; params?: unknown }) => unknown) {
  const path = join(await socketDir(), "runner.sock");
  const seen: { method: string; params?: unknown }[] = [];
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const message = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        seen.push({ method: message.method, params: message.params });
        if (message.id === undefined) continue;
        const reply = answer(message);
        if (reply === undefined) continue;
        socket.write(
          typeof reply === "string" ? reply : `${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply })}\n`,
        );
      }
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(path, done));
  return { path, seen };
}

const report = { projects: [{ path: ".", result: "hit" }] };
const mcpAnswer = (message: { method: string }) =>
  message.method === "initialize"
    ? {
        result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "wardby_tools", version: "1" } },
      }
    : { result: { content: [{ type: "text", text: JSON.stringify(report) }] } };

describe("callPrepareDependencies", () => {
  it("initializes, then calls the prepare tool once with no arguments, and returns its JSON", async () => {
    const { path, seen } = await fakeRunner(mcpAnswer);
    await expect(callPrepareDependencies({ socketPath: path })).resolves.toEqual(report);
    expect(seen.map((entry) => entry.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(seen[2].params).toEqual({ name: PREPARE_DEPENDENCIES_TOOL, arguments: {} });
    expect(PREPARE_DEPENDENCIES_TOOL).toBe("wardby_prepare_dependencies");
  });

  it("passes the run's deadline to the tool when it has one", async () => {
    const { path, seen } = await fakeRunner(mcpAnswer);
    const deadlineAt = "2026-10-12T13:00:00.000Z";
    await expect(callPrepareDependencies({ socketPath: path, deadlineAt })).resolves.toEqual(report);
    expect(seen[2].params).toEqual({ name: PREPARE_DEPENDENCIES_TOOL, arguments: { deadline_at: deadlineAt } });
  });

  it("an older tool runner without the tool is dependency_cache_tool_unavailable", async () => {
    for (const reply of [
      { error: { code: -32602, message: "Tool wardby_prepare_dependencies not found" } },
      { result: { isError: true, content: [{ type: "text", text: "not found" }] } },
    ]) {
      const { path } = await fakeRunner((message) => (message.method === "initialize" ? mcpAnswer(message) : reply));
      await expect(callPrepareDependencies({ socketPath: path })).rejects.toThrow("dependency_cache_tool_unavailable");
    }
  });

  it("fails by name on a timeout, an oversized answer, or text that is not JSON", async () => {
    const silent = await fakeRunner((message) => (message.method === "initialize" ? mcpAnswer(message) : undefined));
    await expect(callPrepareDependencies({ socketPath: silent.path, timeoutMs: 200 })).rejects.toThrow(
      "dependency_cache_tool_failed",
    );
    const huge = await fakeRunner((message) =>
      message.method === "initialize" ? mcpAnswer(message) : `${"x".repeat(300 * 1024)}`,
    );
    await expect(callPrepareDependencies({ socketPath: huge.path, timeoutMs: 2_000 })).rejects.toThrow(
      "dependency_cache_tool_failed",
    );
    const text = await fakeRunner((message) =>
      message.method === "initialize" ? mcpAnswer(message) : { result: { content: [{ type: "text", text: "nope" }] } },
    );
    await expect(callPrepareDependencies({ socketPath: text.path })).rejects.toThrow("dependency_cache_tool_failed");
  });

  it("fails by name when the socket is absent, and when the caller aborts", async () => {
    const path = join(await socketDir(), "runner.sock");
    await expect(callPrepareDependencies({ socketPath: path })).rejects.toThrow("dependency_cache_tool_failed");
    const silent = await fakeRunner((message) => (message.method === "initialize" ? mcpAnswer(message) : undefined));
    const controller = new AbortController();
    const call = callPrepareDependencies({ socketPath: silent.path, signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toThrow("dependency_cache_tool_failed");
  });
});

describe("prepareDependenciesTimeoutMs", () => {
  it("waits for the cache's deadline-capped bound plus its settle grace, never longer than the full bound", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    const short = prepareDependenciesTimeoutMs("2026-10-12T12:10:00Z", now);
    expect(short).toBeGreaterThan(5 * 60_000 + DEFAULT_TIMEOUTS.settleMs);
    expect(short).toBeLessThan(PREPARE_DEPENDENCIES_TIMEOUT_MS);
    // The capped bound already includes the budget walk.
    expect(prepareDependenciesTimeoutMs("2026-10-13T12:00:00Z", now)).toBe(
      DEFAULT_TIMEOUTS.totalMs + DEFAULT_TIMEOUTS.settleMs + 60_000,
    );
    expect(prepareDependenciesTimeoutMs(undefined, now)).toBe(PREPARE_DEPENDENCIES_TIMEOUT_MS);
  });
});

describe("PREPARE_DEPENDENCIES_TIMEOUT_MS", () => {
  it("outlasts everything the tool runner's prepare can take: the budget walk, totalMs and settleMs", () => {
    expect(PREPARE_DEPENDENCIES_TIMEOUT_MS).toBeGreaterThan(
      BUDGET_MEASURE_TIMEOUT_MS + DEFAULT_TIMEOUTS.totalMs + DEFAULT_TIMEOUTS.settleMs,
    );
  });
});

describe("git tools (#536)", () => {
  const answering = (payload: unknown) => (message: { method: string }) =>
    message.method === "initialize"
      ? mcpAnswer(message)
      : { result: { content: [{ type: "text", text: JSON.stringify(payload) }] } };

  it("calls the git check with no arguments and returns its JSON", async () => {
    const { path, seen } = await fakeRunner(answering({ ok: true }));
    await expect(callGitCheck({ socketPath: path })).resolves.toEqual({ ok: true });
    expect(seen[2].params).toEqual({ name: GIT_CHECK_TOOL, arguments: {} });
    expect(GIT_CHECK_TOOL).toBe("wardby_git_check");
  });

  it("calls the result bundle tool with the repository's path and commits", async () => {
    const { path, seen } = await fakeRunner(answering({ ok: true, bundled: true }));
    const repository = { path: "/repos/api", baseCommit: "a".repeat(40), excludeCommits: ["b".repeat(40)] };
    await expect(callResultBundle(repository, { socketPath: path })).resolves.toEqual({ ok: true, bundled: true });
    expect(seen[2].params).toEqual({
      name: RESULT_BUNDLE_TOOL,
      arguments: { path: "/repos/api", base_commit: "a".repeat(40), exclude_commits: ["b".repeat(40)] },
    });
    expect(RESULT_BUNDLE_TOOL).toBe("wardby_result_bundle");
  });

  it("fails by fixed name: an older tool runner without the tools, a dead socket, or a bad answer", async () => {
    const older = await fakeRunner((message) =>
      message.method === "initialize" ? mcpAnswer(message) : { error: { code: -32602, message: "not found" } },
    );
    await expect(callGitCheck({ socketPath: older.path })).rejects.toThrow(/^git_tool_unavailable$/);
    await expect(
      callResultBundle(
        { path: "/workspace", baseCommit: "a".repeat(40), excludeCommits: [] },
        { socketPath: older.path },
      ),
    ).rejects.toThrow(/^git_tool_unavailable$/);
    const missing = join(await socketDir(), "runner.sock");
    await expect(callGitCheck({ socketPath: missing })).rejects.toThrow(/^git_tool_failed$/);
    const text = await fakeRunner((message) =>
      message.method === "initialize" ? mcpAnswer(message) : { result: { content: [{ type: "text", text: "nope" }] } },
    );
    await expect(
      callResultBundle(
        { path: "/workspace", baseCommit: "a".repeat(40), excludeCommits: [] },
        { socketPath: text.path },
      ),
    ).rejects.toThrow(/^git_tool_failed$/);
    const silent = await fakeRunner((message) => (message.method === "initialize" ? mcpAnswer(message) : undefined));
    await expect(callGitCheck({ socketPath: silent.path, timeoutMs: 200 })).rejects.toThrow(/^git_tool_failed$/);
  });
});
