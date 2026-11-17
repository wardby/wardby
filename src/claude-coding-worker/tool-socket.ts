import { createConnection } from "node:net";
import {
  BUDGET_MEASURE_TIMEOUT_MS,
  DEFAULT_TIMEOUTS,
  dependencyCacheTimeLimit,
} from "../coding-worker/dependency-cache.mjs";

/** Where the tool runner listens (claude-tool-runner/main.mjs) and the relay connects (tool-relay.ts). */
export const TOOL_SOCKET_PATH = "/run/wardby/tool/runner.sock";

/**
 * Fails fast, by name, when the tool runner's socket can't be reached, before the model is called.
 * Without it the relay exits, Claude Code runs with no command tool, and the model can only report
 * that it could not run anything: a run that "succeeds" having done nothing. (Under gVisor, for one,
 * a socket bound on a volume the two containers don't share is simply absent from this side.)
 */
export async function assertToolRunnerReachable(socketPath = TOOL_SOCKET_PATH, timeoutMs = 5_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const fail = () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("worker_tool_runner_unreachable"));
    };
    const timer = setTimeout(fail, timeoutMs);
    socket.once("error", fail);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
  });
}

/** The tool runner's internal tool (claude-tool-runner/main.mjs); the agent's SDK options disallow it (sdk.ts). */
export const PREPARE_DEPENDENCIES_TOOL = "wardby_prepare_dependencies";
/** Room for the tool runner and the socket on top of the module's own bounds. */
const PREPARE_DEPENDENCIES_MARGIN_MS = 60_000;
/**
 * Derived from the dependency cache's own bounds (dependency-cache.mjs, the same file the tool runner
 * runs): the budget walk, then the whole prepare (totalMs) and its settle grace, plus a margin. A
 * worker that stops waiting earlier is still safe: the tool runner holds the first command until
 * the cache has finished, and seals before it.
 */
export const PREPARE_DEPENDENCIES_TIMEOUT_MS =
  BUDGET_MEASURE_TIMEOUT_MS + DEFAULT_TIMEOUTS.totalMs + DEFAULT_TIMEOUTS.settleMs + PREPARE_DEPENDENCIES_MARGIN_MS;
const MAX_RESPONSE_LINE_BYTES = 256 * 1024;

export interface PrepareDependenciesCall {
  socketPath?: string;
  /** Defaults to the cache's bound for `deadlineAt` (dependencyCacheTimeLimit) plus its settle grace and a margin. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** The run's deadline (CodingTaskInput.deadlineAt), passed to the tool: the cache takes at most half the time left. */
  deadlineAt?: string;
}

/** How long the worker waits for the prepare tool on a run with this deadline. */
export function prepareDependenciesTimeoutMs(deadlineAt?: string, now = Date.now()): number {
  if (deadlineAt === undefined) return PREPARE_DEPENDENCIES_TIMEOUT_MS;
  return Math.min(
    PREPARE_DEPENDENCIES_TIMEOUT_MS,
    dependencyCacheTimeLimit(deadlineAt, now) + DEFAULT_TIMEOUTS.settleMs + PREPARE_DEPENDENCIES_MARGIN_MS,
  );
}

/**
 * The worker's one call to the tool runner on a dependency-cache run, before the agent starts:
 * PREPARE_DEPENDENCIES_TOOL once (callToolRunner). Resolves with the tool's JSON (unchecked: the
 * caller bounds it). Fails only with `dependency_cache_tool_unavailable` (a tool runner without the
 * tool) or `dependency_cache_tool_failed`; never with the tool runner's text.
 */
export async function callPrepareDependencies({
  socketPath = TOOL_SOCKET_PATH,
  deadlineAt,
  timeoutMs = prepareDependenciesTimeoutMs(deadlineAt),
  signal,
}: PrepareDependenciesCall = {}): Promise<unknown> {
  return callToolRunner(PREPARE_DEPENDENCIES_TOOL, deadlineAt === undefined ? {} : { deadline_at: deadlineAt }, {
    socketPath,
    timeoutMs,
    signal,
    unavailable: "dependency_cache_tool_unavailable",
    failed: "dependency_cache_tool_failed",
  });
}

/** The tool runner's git tools (#536, claude-tool-runner/main.mjs); the agent's SDK options disallow both (sdk.ts). */
export const GIT_CHECK_TOOL = "wardby_git_check";
export const RESULT_BUNDLE_TOOL = "wardby_result_bundle";
/** `git --version`, with room for the socket. */
export const GIT_CHECK_TIMEOUT_MS = 30_000;
/** Above the tool runner's own bound for one bundle (result-bundle.mjs: ten minutes for `git bundle create`, plus its short steps). */
export const RESULT_BUNDLE_TIMEOUT_MS = 15 * 60_000;
/** The tool runner's own bound for one bundle (result-bundle.mjs BUNDLE_TIMEOUT_MS), and how much sooner it stops than the socket call. */
const RESULT_BUNDLE_TOOL_MAX_MS = 10 * 60_000;
const RESULT_BUNDLE_SOCKET_SLACK_MS = 5_000;

export interface GitToolCall {
  socketPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * On a run with git history, before the agent starts: whether the tool runner has git. Resolves with
 * the tool's JSON (`{ ok: true }` when it has); fails only with `git_tool_unavailable` (a tool
 * runner without the tool) or `git_tool_failed`.
 */
export async function callGitCheck({
  socketPath = TOOL_SOCKET_PATH,
  timeoutMs = GIT_CHECK_TIMEOUT_MS,
  signal,
}: GitToolCall = {}): Promise<unknown> {
  return callToolRunner(
    GIT_CHECK_TOOL,
    {},
    {
      socketPath,
      timeoutMs,
      signal,
      unavailable: "git_tool_unavailable",
      failed: "git_tool_failed",
    },
  );
}

/**
 * On a run with git history, after the agent has finished: one repository's result bundle, which the
 * tool runner writes into that repository's .git (it never crosses the socket). Resolves with the
 * tool's small JSON (`{ ok, bundled, reason }`); fails like callGitCheck.
 */
export async function callResultBundle(
  repository: { path: string; baseCommit: string; excludeCommits: readonly string[] },
  { socketPath = TOOL_SOCKET_PATH, timeoutMs = RESULT_BUNDLE_TIMEOUT_MS, signal }: GitToolCall = {},
): Promise<unknown> {
  return callToolRunner(
    RESULT_BUNDLE_TOOL,
    {
      path: repository.path,
      base_commit: repository.baseCommit,
      exclude_commits: [...repository.excludeCommits],
      // The tool runner stops its own git a little before the socket gives up, and removes the partial bundle.
      timeout_ms: Math.max(1_000, Math.min(RESULT_BUNDLE_TOOL_MAX_MS, timeoutMs - RESULT_BUNDLE_SOCKET_SLACK_MS)),
    },
    { socketPath, timeoutMs, signal, unavailable: "git_tool_unavailable", failed: "git_tool_failed" },
  );
}

interface ToolSessionOptions {
  socketPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
  unavailable: string;
  failed: string;
  maxResponseBytes?: number;
}

/**
 * One call to one of the tool runner's tools: opens a session, calls `name` once, closes it.
 * Resolves with the tool's JSON (unchecked). Fails only with `unavailable` (a tool runner without
 * the tool) or `failed`; never with the tool runner's text.
 */
async function callToolRunner(
  name: string,
  args: Record<string, unknown>,
  options: ToolSessionOptions,
): Promise<unknown> {
  const session = await openToolSession(options);
  try {
    return await session.call(name, args);
  } finally {
    session.close();
  }
}

/**
 * One MCP connection to the tool runner (a minimal client: newline-delimited JSON-RPC, as the relay
 * carries), initialized, over which `call` may be made repeatedly (one at a time). `timeoutMs`
 * bounds the whole session. Fails only with `unavailable` or `failed`; never with the tool
 * runner's text.
 */
async function openToolSession({
  socketPath,
  timeoutMs,
  signal,
  unavailable,
  failed: failedCode,
  maxResponseBytes = MAX_RESPONSE_LINE_BYTES,
}: ToolSessionOptions): Promise<{
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): void;
}> {
  const failed = () => new Error(failedCode);
  if (signal?.aborted) throw failed();
  const socket = createConnection(socketPath);
  socket.setEncoding("utf8");
  const pending = new Map<number, { resolve: (message: JsonRpcResponse) => void }>();
  let buffered = "";
  let settle: ((error: Error) => void) | undefined;
  const broken = new Promise<never>((_, reject) => {
    settle = reject;
  });
  // Every waiter races `broken`; keep an unobserved rejection from surfacing.
  broken.catch(() => undefined);
  const fail = (error: Error) => settle?.(error);
  const timer = setTimeout(() => fail(failed()), timeoutMs);
  const onAbort = () => fail(failed());
  signal?.addEventListener("abort", onAbort, { once: true });
  const close = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    socket.destroy();
  };
  socket.on("error", () => fail(failed()));
  socket.once("close", () => fail(failed()));
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        fail(failed());
        return;
      }
      if (typeof message?.id === "number") pending.get(message.id)?.resolve(message);
    }
    if (Buffer.byteLength(buffered) > maxResponseBytes) fail(failed());
  });
  let nextId = 0;
  const request = (method: string, params: unknown): Promise<JsonRpcResponse> => {
    const id = ++nextId;
    const answered = new Promise<JsonRpcResponse>((resolve) => pending.set(id, { resolve }));
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return Promise.race([answered, broken]);
  };
  try {
    await Promise.race([new Promise<void>((resolve) => socket.once("connect", () => resolve())), broken]);
    const initialized = await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "wardby-claude-worker", version: "1.0.0" },
    });
    if (!initialized.result) throw failed();
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  } catch {
    close();
    throw failed();
  }
  return {
    close,
    async call(name, args) {
      try {
        const called = await request("tools/call", { name, arguments: args });
        const result = called.result as
          { isError?: boolean; content?: Array<{ type?: string; text?: unknown }> } | undefined;
        if (called.error || !result || result.isError) throw new Error(unavailable);
        const text = result.content?.find((item) => item.type === "text")?.text;
        if (typeof text !== "string") throw failed();
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw failed();
        }
      } catch (error) {
        if (error instanceof Error && error.message === unavailable) throw error;
        throw failed();
      }
    },
  };
}

/** The tool runner's plan tools (claude-tool-runner/main.mjs); the agent's SDK options disallow all three (sdk.ts). */
export const PLAN_PLACE_TOOL = "wardby_plan_place";
export const PLAN_LIST_TOOL = "wardby_plan_list";
export const PLAN_READ_TOOL = "wardby_plan_read";
/** A maximum-size file (1 MiB, base64) in one JSON-RPC line, with room for its envelope. */
export const PLAN_READ_RESPONSE_BYTES = 2 * 1024 * 1024;
export const PLAN_TOOL_TIMEOUT_MS = 60_000;

export interface PlanToolCall {
  socketPath?: string;
  signal?: AbortSignal;
}

/** One input plan file, placed in the tool runner's plan folder before the agent's first command. */
export async function callPlanPlace(
  file: { path: string; contentBase64: string },
  { socketPath = TOOL_SOCKET_PATH, signal }: PlanToolCall = {},
): Promise<unknown> {
  return callToolRunner(
    PLAN_PLACE_TOOL,
    { path: file.path, content_base64: file.contentBase64 },
    {
      socketPath,
      timeoutMs: PLAN_TOOL_TIMEOUT_MS,
      signal,
      unavailable: "plan_tool_unavailable",
      failed: "plan_tool_failed",
    },
  );
}

/** One connection for the plan list and every read (the tool runner keeps the list per connection). */
export async function openPlanSession({ socketPath = TOOL_SOCKET_PATH, signal }: PlanToolCall = {}) {
  const session = await openToolSession({
    socketPath,
    timeoutMs: 5 * 60_000,
    signal,
    unavailable: "plan_tool_unavailable",
    failed: "plan_tool_failed",
    maxResponseBytes: PLAN_READ_RESPONSE_BYTES,
  });
  return {
    list: () => session.call(PLAN_LIST_TOOL, {}),
    read: (path: string) => session.call(PLAN_READ_TOOL, { path }),
    close: () => session.close(),
  };
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: unknown;
}
