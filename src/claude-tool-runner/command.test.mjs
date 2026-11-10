import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  KILL_GRACE_MS,
  MAX_ENV_ENTRIES,
  MAX_FILES,
  MAX_OUTPUT_BYTES,
  MAX_SETUP_BYTES,
  SHIM_DIRECTORY,
  commandEnvironment,
  commandTimeoutLimits,
  parseToolSetup,
  runCommand,
  toolEnvironment,
} from "./command.mjs";

test("runs commands in the supplied workspace with a scrubbed environment and bounded output", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardby-claude-tools-"));
  try {
    const env = toolEnvironment();
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);

    const result = await runCommand('test -z "$ANTHROPIC_API_KEY" && printf absent', 1_000, workspace);
    assert.deepEqual(result, { code: 0, output: "absent" });

    const bounded = await runCommand("head -c 70000 /dev/zero", 1_000, workspace);
    assert.equal(bounded.code, 0);
    assert.equal(Buffer.byteLength(bounded.output), MAX_OUTPUT_BYTES);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("gives commands a TMPDIR under the workspace's excluded .cache, and creates it", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardby-claude-tools-tmp-"));
  try {
    const env = toolEnvironment(workspace);
    assert.equal(env.TMPDIR, join(workspace, ".cache", "tmp"));

    const result = await runCommand('test -w "$TMPDIR" && printf ok > "$TMPDIR/probe"', 1_000, workspace);
    assert.deepEqual(result, { code: 0, output: "" });
    assert.equal(await readFile(join(workspace, ".cache", "tmp", "probe"), "utf8"), "ok");
    assert.equal((await stat(join(workspace, ".cache", "tmp"))).mode & 0o777, 0o700);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("recreates TMPDIR a previous command deleted, like a setup file", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardby-claude-tools-tmp2-"));
  try {
    await runCommand("rm -rf .cache", 1_000, workspace);
    const result = await runCommand('test -d "$TMPDIR" && printf present', 1_000, workspace);
    assert.deepEqual(result, { code: 0, output: "present" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

const setupFor = (workspace) =>
  JSON.stringify({
    schemaVersion: 1,
    env: {
      npm_config_registry: "http://wardby-proxy:8787/registry/npm/",
      DATABASE_URL: "postgres://test@127.0.0.1/test",
    },
    files: [
      {
        path: `${workspace}/.cache/npm/npmrc`,
        content: "//wardby-proxy:8787/registry/npm/:_authToken=rgt_x\n",
        mode: 0o600,
      },
    ],
  });

test("parses the launcher's setup and refuses anything else", () => {
  assert.deepEqual(parseToolSetup(undefined), { env: {}, files: [] });
  const parsed = parseToolSetup(setupFor("/workspace"));
  assert.equal(parsed.env.npm_config_registry, "http://wardby-proxy:8787/registry/npm/");
  assert.equal(parsed.files[0].path, "/workspace/.cache/npm/npmrc");
  const bad = [
    "not json",
    JSON.stringify({ schemaVersion: 2, env: {}, files: [] }),
    JSON.stringify({ schemaVersion: 1, env: { PATH: "/evil" }, files: [] }),
    JSON.stringify({ schemaVersion: 1, env: { HOME: "/root" }, files: [] }),
    JSON.stringify({ schemaVersion: 1, env: { "bad-name": "x" }, files: [] }),
    JSON.stringify({ schemaVersion: 1, env: { A: 1 }, files: [] }),
    JSON.stringify({ schemaVersion: 1, env: {}, files: [{ path: "/etc/passwd", content: "x", mode: 0o600 }] }),
    JSON.stringify({
      schemaVersion: 1,
      env: {},
      files: [{ path: "/workspace/.cache/../x", content: "x", mode: 0o600 }],
    }),
    JSON.stringify({ schemaVersion: 1, env: {}, files: [{ path: "/workspace/.cache/a", content: "x", mode: 0o777 }] }),
  ];
  for (const raw of bad) assert.throws(() => parseToolSetup(raw), /tool_setup_invalid/, raw);
});

test("parses the dependency cache flag: true only when set, anything but a boolean refused", () => {
  const withFlag = (value) => JSON.stringify({ ...JSON.parse(setupFor("/workspace")), dependencyCache: value });
  assert.equal(parseToolSetup(withFlag(true)).dependencyCache, true);
  assert.equal(parseToolSetup(withFlag(false)).dependencyCache, undefined);
  assert.equal(parseToolSetup(setupFor("/workspace")).dependencyCache, undefined);
  for (const value of ["true", 1, null, {}]) {
    assert.throws(() => parseToolSetup(withFlag(value)), /tool_setup_invalid/, JSON.stringify(value));
  }
});

test("parses the volume size only with the dependency cache flag, within the launchers' bounds", () => {
  const withDisk = (extra) => JSON.stringify({ ...JSON.parse(setupFor("/workspace")), ...extra });
  assert.equal(parseToolSetup(withDisk({ dependencyCache: true, diskMb: 2048 })).diskMb, 2048);
  assert.equal(parseToolSetup(withDisk({ dependencyCache: true })).diskMb, undefined);
  for (const extra of [
    { diskMb: 2048 },
    { dependencyCache: false, diskMb: 2048 },
    { dependencyCache: true, diskMb: 63 },
    { dependencyCache: true, diskMb: 32_769 },
    { dependencyCache: true, diskMb: 1.5 },
    { dependencyCache: true, diskMb: "2048" },
  ]) {
    assert.throws(() => parseToolSetup(withDisk(extra)), /tool_setup_invalid/, JSON.stringify(extra));
  }
});

test("commandEnvironment is exactly what a command's shell gets", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardby-claude-tools-env-"));
  try {
    const setup = parseToolSetup(setupFor(workspace), workspace);
    const env = commandEnvironment(setup, workspace);
    assert.deepEqual(env, { ...setup.env, ...toolEnvironment(workspace) });
    const result = await runCommand("env", 1_000, workspace, setup);
    const shellNames = new Set(
      result.output
        .trim()
        .split("\n")
        .map((line) => line.split("=")[0]),
    );
    for (const name of Object.keys(env)) assert.ok(shellNames.has(name), name);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("gives each command the setup's variables and files, the shim first on PATH, and never the raw setup", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardby-claude-tools-setup-"));
  try {
    const setup = parseToolSetup(setupFor(workspace), workspace);
    const result = await runCommand(
      'printf "%s|%s|%s" "$npm_config_registry" "$DATABASE_URL" "${WARDBY_TOOL_SETUP:-unset}"',
      5_000,
      workspace,
      setup,
    );
    assert.deepEqual(result, {
      code: 0,
      output: "http://wardby-proxy:8787/registry/npm/|postgres://test@127.0.0.1/test|unset",
    });
    assert.equal(
      await readFile(join(workspace, ".cache/npm/npmrc"), "utf8"),
      "//wardby-proxy:8787/registry/npm/:_authToken=rgt_x\n",
    );
    assert.equal((await stat(join(workspace, ".cache/npm/npmrc"))).mode & 0o777, 0o600);
    assert.ok(toolEnvironment().PATH.startsWith(`${SHIM_DIRECTORY}:`));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("rewrites a setup file a previous command deleted", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardby-claude-tools-setup-"));
  try {
    const setup = parseToolSetup(setupFor(workspace), workspace);
    await runCommand("rm -rf .cache", 5_000, workspace, setup);
    const result = await runCommand("cat .cache/npm/npmrc", 5_000, workspace, setup);
    assert.equal(result.code, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a timeout kills the command's whole process group, so a background grandchild can't hold the pipes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardby-claude-tools-timeout-"));
  try {
    const started = Date.now();
    const result = await runCommand('sleep 30 & echo "$!"; sleep 30', 1_000, workspace);
    const elapsed = Date.now() - started;
    assert.equal(result.code, 124);
    assert.ok(elapsed < 5_000, `took ${elapsed} ms`);
    const grandchild = Number(result.output.trim());
    assert.ok(Number.isSafeInteger(grandchild) && grandchild > 0, result.output);
    assert.throws(() => process.kill(grandchild, 0), { code: "ESRCH" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a timed-out command that ignores SIGTERM is killed after the grace period", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardby-claude-tools-sigkill-"));
  try {
    const started = Date.now();
    const result = await runCommand("trap '' TERM; sleep 30", 1_000, workspace);
    const elapsed = Date.now() - started;
    assert.equal(result.code, 124);
    assert.ok(elapsed >= 1_000 + KILL_GRACE_MS - 100 && elapsed < 1_000 + KILL_GRACE_MS + 2_000, `took ${elapsed} ms`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("accepts a setup at the entry and file caps and refuses one past them", () => {
  const withEnv = (count) =>
    JSON.stringify({
      schemaVersion: 1,
      env: Object.fromEntries(Array.from({ length: count }, (_, index) => [`V${index}`, "x"])),
      files: [],
    });
  assert.equal(Object.keys(parseToolSetup(withEnv(MAX_ENV_ENTRIES)).env).length, MAX_ENV_ENTRIES);
  assert.throws(() => parseToolSetup(withEnv(MAX_ENV_ENTRIES + 1)), /tool_setup_invalid/);

  const withFiles = (count) =>
    JSON.stringify({
      schemaVersion: 1,
      env: {},
      files: Array.from({ length: count }, (_, index) => ({
        path: `/workspace/.cache/f${index}`,
        content: "x",
        mode: 0o600,
      })),
    });
  assert.equal(parseToolSetup(withFiles(MAX_FILES)).files.length, MAX_FILES);
  assert.throws(() => parseToolSetup(withFiles(MAX_FILES + 1)), /tool_setup_invalid/);

  const padded = (bytes) => {
    const empty = JSON.stringify({ schemaVersion: 1, env: { PAD: "" }, files: [] });
    return JSON.stringify({ schemaVersion: 1, env: { PAD: "x".repeat(bytes - empty.length) }, files: [] });
  };
  assert.throws(() => parseToolSetup(padded(MAX_SETUP_BYTES + 1)), /tool_setup_invalid/);
});

test("stops a command at the setup's longest per-command timeout, whatever the call asks for", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardby-claude-tools-max-"));
  try {
    const setup = parseToolSetup(
      JSON.stringify({ schemaVersion: 1, env: {}, files: [], commandTimeouts: { defaultMs: 1_000, maxMs: 1_500 } }),
      workspace,
    );
    assert.deepEqual(commandTimeoutLimits(setup), { defaultMs: 1_000, maxMs: 1_500 });
    const started = Date.now();
    const result = await runCommand("sleep 6", 30_000, workspace, setup);
    const elapsed = Date.now() - started;
    assert.equal(result.code, 124);
    assert.ok(elapsed < 5_000, `took ${elapsed} ms`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
