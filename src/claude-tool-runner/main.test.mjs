import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseToolSetup, toolEnvironment } from "./command.mjs";
import {
  BUDGET_MEASURE_TIMEOUT_MS,
  DEFAULT_TIMEOUTS,
  dependencyCacheBudget,
  dependencyCacheTimeLimit,
} from "../coding-worker/dependency-cache.mjs";
import {
  GIT_CHECK_TOOL,
  PREPARE_DEPENDENCIES_TOOL,
  RESULT_BUNDLE_TOOL,
  startToolRunner,
  TOOL_RUNNER_READY_MESSAGE,
} from "./main.mjs";

test("exposes a fixed lifecycle readiness marker", () => {
  assert.equal(TOOL_RUNNER_READY_MESSAGE, "wardby_tool_runner_ready");
});

function waitForResponse(socket, id) {
  return new Promise((resolve, reject) => {
    let pending = "";
    const onData = (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === id) {
            socket.off("data", onData);
            resolve(message);
          }
        } catch (error) {
          socket.off("data", onData);
          reject(error);
        }
      }
    };
    socket.on("data", onData);
  });
}

test("serves the bounded run_command MCP tool and the worker's internal git tools over its private socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wardby-claude-mcp-"));
  const socketPath = join(directory, "runner.sock");
  const server = await startToolRunner(socketPath);
  const socket = net.createConnection(socketPath);
  try {
    await once(socket, "connect");
    const initialized = waitForResponse(socket, 1);
    socket.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
      })}\n`,
    );
    const init = await initialized;
    assert.equal(init.result.serverInfo.name, "wardby_tools");

    socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listed = waitForResponse(socket, 2);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const tools = await listed;
    // The git tools are the worker's own (#536); the agent's SDK options disallow them (sdk.ts).
    assert.deepEqual(
      tools.result.tools.map((tool) => tool.name),
      ["run_command", GIT_CHECK_TOOL, RESULT_BUNDLE_TOOL],
    );
  } finally {
    socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("offers run_command with the setup's per-command timeouts, and the old 60 s / 120 s without them", async () => {
  const listRunCommand = async (setup) => {
    const directory = await mkdtemp(join(tmpdir(), "wardby-claude-limits-"));
    const socketPath = join(directory, "runner.sock");
    const server = await startToolRunner(socketPath, setup);
    const client = await connect(socketPath);
    try {
      const listed = await client.request("tools/list");
      return listed.result.tools.find((tool) => tool.name === "run_command");
    } finally {
      client.socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  };
  const raised = await listRunCommand(
    parseToolSetup(
      JSON.stringify({ schemaVersion: 1, env: {}, files: [], commandTimeouts: { defaultMs: 600_000, maxMs: 900_000 } }),
    ),
  );
  assert.equal(raised.inputSchema.properties.timeout_ms.maximum, 900_000);
  assert.match(raised.description, /stopped after 600 s unless timeout_ms asks for more, up to 900 s/);
  const capped = await listRunCommand(
    parseToolSetup(
      JSON.stringify({ schemaVersion: 1, env: {}, files: [], commandTimeouts: { defaultMs: 300_000, maxMs: 300_000 } }),
    ),
  );
  assert.equal(capped.inputSchema.properties.timeout_ms.maximum, 300_000);
  assert.match(capped.description, /stopped after 300 s\.$/);
  const legacy = await listRunCommand(parseToolSetup(undefined));
  assert.equal(legacy.inputSchema.properties.timeout_ms.maximum, 120_000);
});

// ---------------------------------------------------------------- dependency cache

/** A minimal MCP client over the tool runner's socket, like the relay. */
async function connect(socketPath) {
  const socket = net.createConnection(socketPath);
  await once(socket, "connect");
  let id = 0;
  const request = async (method, params = {}) => {
    id += 1;
    const response = waitForResponse(socket, id);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  };
  await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return { socket, request };
}

const callTool = (client, name, args = {}) => client.request("tools/call", { name, arguments: args });
const toolJson = (response) => JSON.parse(response.result.content[0].text);

async function withRunner({ dependencyCache = true, diskMb = 2048, module } = {}, body) {
  const directory = await mkdtemp(join(tmpdir(), "wardby-claude-depcache-"));
  const workspace = join(directory, "workspace");
  const socketPath = join(directory, "runner.sock");
  const setup = parseToolSetup(
    JSON.stringify({
      schemaVersion: 1,
      env: {
        npm_config_registry: "http://wardby-proxy:8787/registry/npm/",
        npm_config_userconfig: `${workspace}/.cache/npm/npmrc`,
        WARDBY_NPM_PLAN_REGISTRY: "http://wardby-proxy:8787/registry/npm/",
        DATABASE_URL: "postgres://db",
      },
      files: [
        {
          path: `${workspace}/.cache/npm/npmrc`,
          content: "//wardby-proxy:8787/registry/npm/:_authToken=rgt_x\n",
          mode: 0o600,
        },
      ],
      ...(dependencyCache ? { dependencyCache: true, ...(diskMb === null ? {} : { diskMb }) } : {}),
    }),
    workspace,
  );
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  const server = await startToolRunner(socketPath, setup, {
    workspacePath: workspace,
    ...(module === "real" ? {} : { loadDependencyCache: async () => module }),
  });
  const clients = [];
  try {
    await body({
      workspace,
      setup,
      connect: async () => {
        const client = await connect(socketPath);
        clients.push(client);
        return client;
      },
    });
  } finally {
    for (const client of clients) client.socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

function fakeModule(order = []) {
  const calls = { prepare: [], seal: [] };
  return {
    calls,
    BUDGET_MEASURE_TIMEOUT_MS,
    dependencyCacheTimeLimit,
    dependencyCacheBudget: (options) => {
      order.push("budget");
      calls.budget = options;
      return dependencyCacheBudget(options);
    },
    prepareDependencies: async (options) => {
      order.push("prepare");
      calls.prepare.push(options);
      return { projects: [{ path: ".", result: "hit", key: "abc", sizeBytes: 1, restoreMs: 1, rebuild: "skipped" }] };
    },
    sealUploadWindow: async (options) => {
      order.push("seal");
      calls.seal.push(options);
      return { status: 200, confirmed: true };
    },
  };
}

test("offers the prepare tool only on a dependency-cache run", async () => {
  for (const dependencyCache of [false, true]) {
    await withRunner({ dependencyCache, module: fakeModule() }, async ({ connect }) => {
      const client = await connect();
      const listed = await client.request("tools/list");
      assert.deepEqual(
        listed.result.tools.map((tool) => tool.name),
        dependencyCache
          ? ["run_command", PREPARE_DEPENDENCIES_TOOL, GIT_CHECK_TOOL, RESULT_BUNDLE_TOOL]
          : ["run_command", GIT_CHECK_TOOL, RESULT_BUNDLE_TOOL],
      );
    });
  }
});

test("prepares once per tool runner, with the commands' env and setup files, and returns the same result", async () => {
  const module = fakeModule();
  await withRunner({ module }, async ({ connect, workspace, setup }) => {
    process.env.WARDBY_RUN_CAPABILITY = "rrp_tool_runner_sentinel";
    try {
      const first = await connect();
      const result = toolJson(await callTool(first, PREPARE_DEPENDENCIES_TOOL));
      const second = await connect();
      assert.deepEqual(toolJson(await callTool(second, PREPARE_DEPENDENCIES_TOOL)), result);
      assert.equal(result.projects[0].result, "hit");
      assert.equal(module.calls.prepare.length, 1);
      const [options] = module.calls.prepare;
      assert.equal(options.workspace, workspace);
      assert.deepEqual(options.env, { ...setup.env, ...toolEnvironment(workspace) });
      assert.ok(!JSON.stringify(options.env).includes("rrp_tool_runner_sentinel"));
      // The registry's npmrc is written before the module reads it.
      assert.match(await readFile(`${workspace}/.cache/npm/npmrc`, "utf8"), /_authToken=rgt_x/);
      assert.ok((await stat(`${workspace}/.cache/tmp`)).isDirectory());
      assert.equal(module.calls.seal.length, 0);
    } finally {
      delete process.env.WARDBY_RUN_CAPABILITY;
    }
  });
});

test("refuses to prepare once a command has run (already_started)", async () => {
  const module = fakeModule();
  await withRunner({ module }, async ({ connect }) => {
    const client = await connect();
    await callTool(client, "run_command", { command: "true" });
    assert.deepEqual(toolJson(await callTool(client, PREPARE_DEPENDENCIES_TOOL)), {
      projects: [],
      reason: "already_started",
    });
    assert.equal(module.calls.prepare.length, 0);
  });
});

test("seals before the first command when prepare never ran, once", async () => {
  const order = [];
  const module = fakeModule(order);
  const sealed = module.sealUploadWindow;
  module.sealUploadWindow = async (options) => {
    // The command has not run yet when the seal goes out.
    await assert.rejects(stat(join(options.env.TMPDIR, "..", "..", "marker")));
    return sealed(options);
  };
  await withRunner({ module }, async ({ connect, workspace, setup }) => {
    const client = await connect();
    await callTool(client, "run_command", { command: "touch marker" });
    await callTool(client, "run_command", { command: "true" });
    assert.deepEqual(order, ["seal"]);
    assert.deepEqual(module.calls.seal[0].env, { ...setup.env, ...toolEnvironment(workspace) });
    await stat(join(workspace, "marker"));
  });
});

test("a command after prepare seals once more (idempotent), and only once", async () => {
  const order = [];
  const module = fakeModule(order);
  await withRunner({ module }, async ({ connect }) => {
    const client = await connect();
    await callTool(client, PREPARE_DEPENDENCIES_TOOL);
    await callTool(client, "run_command", { command: "true" });
    await callTool(client, "run_command", { command: "true" });
    assert.deepEqual(order, ["budget", "prepare", "seal"]);
  });
});

test("a prepare that failed still leaves the window sealed before the first command", async () => {
  const order = [];
  const module = fakeModule(order);
  module.prepareDependencies = async () => {
    order.push("prepare");
    throw new Error("boom");
  };
  module.sealUploadWindow = async (options) => {
    await assert.rejects(stat(join(options.env.TMPDIR, "..", "..", "marker")));
    order.push("seal");
    return { status: 200, confirmed: true };
  };
  await withRunner({ module }, async ({ connect, workspace }) => {
    const client = await connect();
    assert.deepEqual(toolJson(await callTool(client, PREPARE_DEPENDENCIES_TOOL)), {
      projects: [],
      reason: "worker_error",
    });
    await callTool(client, "run_command", { command: "touch marker" });
    assert.deepEqual(order, ["budget", "prepare", "seal"]);
    await stat(join(workspace, "marker"));
  });
});

test("budgets the run's volume minus what the workspace uses; a tiny volume is a skip, not an attempt", async () => {
  const module = fakeModule();
  await withRunner({ module, diskMb: 1024 }, async ({ connect, workspace }) => {
    await writeFile(join(workspace, "big.bin"), Buffer.alloc(5 * 1024 * 1024, 1));
    const client = await connect();
    await callTool(client, PREPARE_DEPENDENCIES_TOOL);
    const [options] = module.calls.prepare;
    assert.ok(options.budgetBytes > 0);
    assert.ok(options.budgetBytes <= (1024 - 5 - 64) * 1024 * 1024, String(options.budgetBytes));
  });
  for (const [diskMb, reason] of [
    [64, "budget_too_small"],
    [null, "budget_unknown"],
  ]) {
    const order = [];
    const small = fakeModule(order);
    await withRunner({ module: small, diskMb }, async ({ connect }) => {
      const client = await connect();
      assert.deepEqual(toolJson(await callTool(client, PREPARE_DEPENDENCIES_TOOL)), { projects: [], reason });
      await callTool(client, "run_command", { command: "true" });
      assert.deepEqual(order, ["budget", "seal"]);
    });
  }
});

test("a command arriving while prepare runs waits for it to finish", async () => {
  const order = [];
  let release;
  const module = fakeModule(order);
  module.prepareDependencies = async () => {
    order.push("prepare:start");
    await new Promise((resolve) => (release = resolve));
    order.push("prepare:end");
    return { projects: [] };
  };
  await withRunner({ module }, async ({ connect, workspace }) => {
    const client = await connect();
    const preparing = callTool(client, PREPARE_DEPENDENCIES_TOOL);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    const other = await connect();
    const command = callTool(other, "run_command", { command: "echo ran > ran.txt" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(stat(join(workspace, "ran.txt")));
    release();
    await preparing;
    await command;
    assert.deepEqual(order, ["budget", "prepare:start", "prepare:end", "seal"]);
    await stat(join(workspace, "ran.txt"));
  });
});

test("a module that fails to load or throws is a stable worker_error, and commands still run", async () => {
  await withRunner({ module: undefined }, async ({ connect, workspace }) => {
    const client = await connect();
    assert.deepEqual(toolJson(await callTool(client, PREPARE_DEPENDENCIES_TOOL)), {
      projects: [],
      reason: "worker_error",
    });
    const ran = await callTool(client, "run_command", { command: "echo ok > ok.txt" });
    assert.equal(ran.result.isError, false);
    await writeFile(join(workspace, "noop"), "");
  });
});

test("loads the real module from ../coding-worker, where the image puts it", async () => {
  await withRunner({ module: "real" }, async ({ connect }) => {
    const client = await connect();
    // No lockfile in the workspace: the real module answers without touching the network.
    assert.deepEqual(toolJson(await callTool(client, PREPARE_DEPENDENCIES_TOOL)), {
      projects: [{ path: ".", result: "skipped", reason: "no_lockfile" }],
    });
  });
});

test("caps the cache at half the time left before the deadline the worker passes, the budget walk included", async () => {
  const module = fakeModule();
  await withRunner({ module }, async ({ connect }) => {
    const client = await connect();
    const deadlineAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await callTool(client, PREPARE_DEPENDENCIES_TOOL, { deadline_at: deadlineAt });
    const totalMs = module.calls.prepare[0].timeouts.totalMs;
    assert.ok(totalMs <= 5 * 60_000 && totalMs > 5 * 60_000 - 10_000, String(totalMs));
    assert.equal(module.calls.budget.timeoutMs, BUDGET_MEASURE_TIMEOUT_MS);
  });
  const unbounded = fakeModule();
  await withRunner({ module: unbounded }, async ({ connect }) => {
    // An older worker sends no deadline: the module's own bound.
    await callTool(await connect(), PREPARE_DEPENDENCIES_TOOL);
    const totalMs = unbounded.calls.prepare[0].timeouts.totalMs;
    assert.ok(totalMs <= DEFAULT_TIMEOUTS.totalMs && totalMs > DEFAULT_TIMEOUTS.totalMs - 10_000, String(totalMs));
  });
});

test("refuses an unreadable deadline and skips a passed one, never preparing", async () => {
  for (const [deadline, reason] of [
    ["not a date", "invalid_deadline"],
    [new Date(Date.now() - 1_000).toISOString(), "timeout"],
  ]) {
    const order = [];
    const module = fakeModule(order);
    await withRunner({ module }, async ({ connect }) => {
      const client = await connect();
      const result = toolJson(await callTool(client, PREPARE_DEPENDENCIES_TOOL, { deadline_at: deadline }));
      assert.deepEqual(result, { projects: [], reason });
      await callTool(client, "run_command", { command: "true" });
      assert.deepEqual(order, ["seal"]);
    });
  }
});

test("a worker that hangs up stops the prepare (its signal aborts)", async () => {
  const module = fakeModule();
  let aborted;
  module.prepareDependencies = (options) =>
    new Promise((resolve) => {
      aborted = new Promise((done) => options.signal.addEventListener("abort", done, { once: true }));
      void aborted.then(() => resolve({ projects: [], reason: "cancelled" }));
    });
  await withRunner({ module }, async ({ connect }) => {
    const client = await connect();
    void callTool(client, PREPARE_DEPENDENCIES_TOOL).catch(() => undefined);
    while (!aborted) await new Promise((resolve) => setTimeout(resolve, 5));
    client.socket.destroy();
    await aborted;
    const other = await connect();
    const ran = await callTool(other, "run_command", { command: "true" });
    assert.equal(ran.result.isError, false);
  });
});

// ---------------------------------------------------------------- git history (#536)

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A tool runner over a workspace (and /repos root) holding real shallow clones with one agent commit. */
async function withGitRunner(options, body) {
  const directory = await mkdtemp(join(tmpdir(), "wardby-claude-git-"));
  const upstream = join(directory, "upstream");
  const workspace = join(directory, "workspace");
  const reposRoot = join(directory, "repos");
  const socketPath = join(directory, "runner.sock");
  await mkdir(upstream);
  git(upstream, "init", "-q", "-b", "main");
  await writeFile(join(upstream, "a.txt"), "a\n");
  git(upstream, "add", "a.txt");
  git(upstream, "commit", "-q", "-m", "base");
  const base = git(upstream, "rev-parse", "HEAD");
  await mkdir(reposRoot);
  for (const repo of [workspace, join(reposRoot, "api")]) {
    git(directory, "clone", "-q", "--depth", "1", "--no-local", `file://${upstream}`, repo);
    await writeFile(join(repo, "b.txt"), "b\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "agent");
  }
  const server = await startToolRunner(socketPath, parseToolSetup(undefined), {
    workspacePath: workspace,
    reposRoot,
    ...options,
  });
  const clients = [];
  try {
    await body({
      base,
      workspace,
      reposRoot,
      connect: async () => {
        const client = await connect(socketPath);
        clients.push(client);
        return client;
      },
    });
  } finally {
    for (const client of clients) client.socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test("the git check answers ok with git, and git_unavailable without it", async () => {
  await withGitRunner({}, async ({ connect }) => {
    assert.deepEqual(toolJson(await callTool(await connect(), GIT_CHECK_TOOL)), { ok: true });
  });
  await withGitRunner({ gitBinary: join(tmpdir(), "wardby-no-such-git") }, async ({ connect }) => {
    assert.deepEqual(toolJson(await callTool(await connect(), GIT_CHECK_TOOL)), {
      ok: false,
      reason: "git_unavailable",
    });
  });
  await withGitRunner(
    {
      loadResultBundle: async () => {
        throw new Error("missing");
      },
    },
    async ({ connect }) => {
      assert.deepEqual(toolJson(await callTool(await connect(), GIT_CHECK_TOOL)), {
        ok: false,
        reason: "git_unavailable",
      });
    },
  );
});

test("the result bundle tool writes the bundle into the repository's .git and answers small JSON", async () => {
  await withGitRunner({}, async ({ connect, base, workspace, reposRoot }) => {
    const client = await connect();
    for (const [path, folder] of [
      ["/workspace", workspace],
      ["/repos/api", join(reposRoot, "api")],
    ]) {
      const response = await callTool(client, RESULT_BUNDLE_TOOL, {
        path,
        base_commit: base,
        exclude_commits: [],
      });
      assert.deepEqual(toolJson(response), { ok: true, bundled: true });
      // The bundle itself never crosses the socket.
      assert.ok(response.result.content[0].text.length < 128);
      const head = git(folder, "rev-parse", "HEAD");
      assert.equal(
        git(folder, "bundle", "list-heads", join(folder, ".git", "wardby-result.bundle")),
        `${head} refs/wardby/bundle-head`,
      );
    }
    // HEAD at the base: nothing to bundle.
    git(workspace, "reset", "-q", "--hard", base);
    assert.deepEqual(
      toolJson(
        await callTool(client, RESULT_BUNDLE_TOOL, { path: "/workspace", base_commit: base, exclude_commits: [] }),
      ),
      { ok: true, bundled: false, reason: "no_new_commits" },
    );
    await assert.rejects(stat(join(workspace, ".git", "wardby-result.bundle")));
  });
});

test("the result bundle tool answers a fixed code on failure, never git's output", async () => {
  await withGitRunner({}, async ({ connect, base, workspace }) => {
    const client = await connect();
    assert.deepEqual(
      toolJson(await callTool(client, RESULT_BUNDLE_TOOL, { path: "/etc", base_commit: base, exclude_commits: [] })),
      { ok: false, reason: "result_bundle_path_invalid" },
    );
    await writeFile(join(workspace, ".git", "shallow"), "ghp_FAKESECRET0123456789abcdefABCDEF012345\n");
    const response = await callTool(client, RESULT_BUNDLE_TOOL, {
      path: "/workspace",
      base_commit: base,
      exclude_commits: [],
    });
    assert.deepEqual(toolJson(response), { ok: false, reason: "result_bundle_shallow_invalid" });
    assert.ok(!JSON.stringify(response).includes("FAKESECRET"));
    // A malformed commit never reaches git: the tool's schema refuses it.
    const refused = await callTool(client, RESULT_BUNDLE_TOOL, {
      path: "/workspace",
      base_commit: "--all",
      exclude_commits: [],
    });
    assert.equal(refused.result.isError, true);
  });
});

test("the git tools are not commands: a bundle before any command leaves the dependency gate alone", async () => {
  await withGitRunner({}, async ({ connect, base }) => {
    const client = await connect();
    await callTool(client, RESULT_BUNDLE_TOOL, { path: "/workspace", base_commit: base, exclude_commits: [] });
    const ran = await callTool(client, "run_command", { command: "git --version" });
    assert.match(ran.result.content[0].text, /^exit_code=0\ngit version /);
  });
});
