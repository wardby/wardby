// Forwarding run_command to a toolchain's command agent (#599). The real client is the Rust
// `wardby-cmd` binary; these tests inject the spawn and stand in a tiny shell script for it,
// which checks its arguments, reads the token file as the client does, and then runs the
// command locally (or prints one of the client's fixed failure lines).
import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  COMMAND_AGENT,
  KILL_GRACE_MS,
  MAX_OUTPUT_BYTES,
  TOOLCHAIN_FAILURES,
  parseToolSetup,
  runCommand,
  toolchainEnvironment,
} from "./command.mjs";

const TOOLCHAIN = { address: "127.0.0.1:7071", tokenFile: "/opt/wardby-cmd/token" };
const FAKE_TOKEN = "fake-toolchain-token-7b1e4c";
const FAKE_PIP_PASSWORD = "fake-pip-password-3d9a";
const FAKE_PIP_INDEX_URL = `http://wardby:${FAKE_PIP_PASSWORD}@wardby-proxy:8787/registry/pypi/simple/`;

const withToolchain = (extra = {}) =>
  JSON.stringify({ schemaVersion: 1, env: { DATABASE_URL: "postgres://t@127.0.0.1/t" }, files: [], ...extra });

test("parses a toolchain: a loopback address and a token file under /opt/wardby-cmd/ only", () => {
  assert.deepEqual(parseToolSetup(withToolchain({ toolchain: TOOLCHAIN })).toolchain, TOOLCHAIN);
  assert.equal(parseToolSetup(withToolchain()).toolchain, undefined);
  const bad = [
    null,
    "127.0.0.1:7071",
    {},
    { address: "127.0.0.1:7071" },
    { tokenFile: "/opt/wardby-cmd/token" },
    { address: "10.0.0.5:7071", tokenFile: "/opt/wardby-cmd/token" },
    { address: "localhost:7071", tokenFile: "/opt/wardby-cmd/token" },
    { address: "0.0.0.0:7071", tokenFile: "/opt/wardby-cmd/token" },
    { address: "127.0.0.1", tokenFile: "/opt/wardby-cmd/token" },
    { address: "127.0.0.1:0", tokenFile: "/opt/wardby-cmd/token" },
    { address: "127.0.0.1:65536", tokenFile: "/opt/wardby-cmd/token" },
    { address: "127.0.0.1:7071 ", tokenFile: "/opt/wardby-cmd/token" },
    { address: 7071, tokenFile: "/opt/wardby-cmd/token" },
    { address: "127.0.0.1:7071", tokenFile: "/run/wardby/token" },
    { address: "127.0.0.1:7071", tokenFile: "/opt/wardby-cmd/" },
    { address: "127.0.0.1:7071", tokenFile: "/opt/wardby-cmd/../etc/passwd" },
    { address: "127.0.0.1:7071", tokenFile: "/opt/wardby-cmd-evil/token" },
    { address: "127.0.0.1:7071", tokenFile: "opt/wardby-cmd/token" },
    { address: "127.0.0.1:7071", tokenFile: "/opt/wardby-cmd/token\0" },
    { ...TOOLCHAIN, extra: true },
  ];
  for (const toolchain of bad)
    assert.throws(() => parseToolSetup(withToolchain({ toolchain })), /tool_setup_invalid/, JSON.stringify(toolchain));
});

test("toolchainEnvironment: the setup's variables, then Wardby's fixed values, never PATH or LANG", () => {
  const setup = parseToolSetup(
    withToolchain({ toolchain: TOOLCHAIN, env: { PIP_INDEX_URL: FAKE_PIP_INDEX_URL, USER: "svc", A: "1" } }),
  );
  assert.deepEqual(toolchainEnvironment(setup, "/workspace"), {
    PIP_INDEX_URL: FAKE_PIP_INDEX_URL,
    A: "1",
    HOME: "/home/wardby",
    USER: "wardby",
    LOGNAME: "wardby",
    TMPDIR: "/workspace/.cache/tmp",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "/workspace",
  });
  const env = toolchainEnvironment(setup, "/elsewhere");
  assert.equal(env.PATH, undefined);
  assert.equal(env.LANG, undefined);
  assert.equal(env.TMPDIR, "/elsewhere/.cache/tmp");
  assert.equal(env.GIT_CONFIG_VALUE_0, "/elsewhere");
});

/**
 * A stand-in for the wardby-cmd client. `mode` "forward" runs the command locally with the
 * image's PATH (the real agent keeps the image's own); the others print a fixed client line.
 */
async function fakeAgent(dir, mode = "forward") {
  const path = join(dir, "wardby-cmd");
  const body = {
    forward: 'PATH=/usr/local/bin:/usr/bin:/bin exec "$@"',
    setupFailed: 'echo "wardby-cmd: toolchain_setup_failed" >&2; exit 125',
    shell: 'echo "wardby-cmd: toolchain_unusable:shell" >&2; exit 125',
    agent: 'echo "wardby-cmd: toolchain_unusable:agent" >&2; exit 125',
    // Output the command produced (here: the token and a registry password) before the connection dropped.
    lost: `printf '%s %s\\n' "$(cat "$TOKEN_FILE")" "$PIP_INDEX_URL"; echo "wardby-cmd: connection lost" >&2; exit 125`,
    // A command's own exit 125 whose last stderr line is not one of the client's.
    plain125: 'echo "wardby-cmd: something else" >&2; exit 125',
  }[mode];
  await writeFile(
    path,
    [
      "#!/bin/sh",
      '[ "$1" = run ] || exit 91',
      "ADDRESS=$2 TOKEN_FILE=$3; shift 3",
      '[ "$1" = -- ] || exit 92; shift',
      '[ -s "$TOKEN_FILE" ] || { echo "wardby-cmd: toolchain_unusable:agent" >&2; exit 125; }',
      body,
      "",
    ].join("\n"),
  );
  await chmod(path, 0o755);
  return path;
}

/** Records every spawn and runs the fake client in place of COMMAND_AGENT. */
function recordingSpawn(agentPath, calls) {
  return (file, args, options) => {
    calls.push({ file, args, env: { ...options.env }, cwd: options.cwd, detached: options.detached });
    return nodeSpawn(file === COMMAND_AGENT ? agentPath : file, args, options);
  };
}

async function fixture(mode, { env = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wardby-toolchain-"));
  const workspace = join(dir, "workspace");
  await mkdir(workspace);
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, `${FAKE_TOKEN}\n`, { mode: 0o400 });
  const parsed = parseToolSetup(withToolchain({ toolchain: TOOLCHAIN, env: { DATABASE_URL: "x", ...env } }), workspace);
  // The test's token file lives in a temp folder; parseToolSetup only accepts /opt/wardby-cmd/.
  const setup = Object.freeze({ ...parsed, toolchain: Object.freeze({ ...TOOLCHAIN, tokenFile }) });
  const calls = [];
  const spawn = recordingSpawn(await fakeAgent(dir, mode), calls);
  return { dir, workspace, setup, calls, spawn, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("forwards the command to the agent as /bin/sh -c (no login shell), in its own group, from the workspace", async () => {
  const f = await fixture("forward");
  try {
    const result = await runCommand('printf "%s|%s" "$USER" "$HOME"', 5_000, f.workspace, f.setup, { spawn: f.spawn });
    assert.deepEqual(result, { code: 0, output: "wardby|/home/wardby" });
    assert.equal(f.calls.length, 1);
    const [call] = f.calls;
    assert.equal(call.file, COMMAND_AGENT);
    assert.equal(COMMAND_AGENT, "/opt/wardby/bin/wardby-cmd");
    assert.deepEqual(call.args, [
      "run",
      TOOLCHAIN.address,
      f.setup.toolchain.tokenFile,
      "--",
      "/bin/sh",
      "-c",
      'printf "%s|%s" "$USER" "$HOME"',
    ]);
    assert.equal(call.cwd, f.workspace);
    assert.equal(call.detached, true);
    assert.deepEqual(call.env, toolchainEnvironment(f.setup, f.workspace));
  } finally {
    await f.cleanup();
  }
});

test("a toolchain command keeps the remote exit code and the 64 KiB output cap", async () => {
  const f = await fixture("forward");
  try {
    assert.deepEqual(
      await runCommand("echo nope; exit 3", 5_000, f.workspace, f.setup, { spawn: f.spawn, lookup: async () => [] }),
      {
        code: 3,
        output: "nope\n",
      },
    );
    const bounded = await runCommand("head -c 70000 /dev/zero", 5_000, f.workspace, f.setup, { spawn: f.spawn });
    assert.equal(bounded.code, 0);
    assert.equal(Buffer.byteLength(bounded.output), MAX_OUTPUT_BYTES);
  } finally {
    await f.cleanup();
  }
});

test("a toolchain command that times out is killed with its client's group (SIGTERM, then SIGKILL) and exits 124", async () => {
  const f = await fixture("forward");
  try {
    const started = Date.now();
    const result = await runCommand("trap '' TERM; sleep 30", 1_000, f.workspace, f.setup, {
      spawn: f.spawn,
      lookup: async () => [],
    });
    const elapsed = Date.now() - started;
    assert.equal(result.code, 124);
    assert.ok(elapsed >= 1_000 + KILL_GRACE_MS - 100 && elapsed < 1_000 + KILL_GRACE_MS + 2_000, `took ${elapsed} ms`);
  } finally {
    await f.cleanup();
  }
});

test("a failed toolchain command still gets the registry's refusals appended, looked up with the setup's registry", async () => {
  const f = await fixture("forward", { env: { PIP_INDEX_URL: FAKE_PIP_INDEX_URL } });
  try {
    const seen = [];
    const lookup = async (access) => {
      seen.push(access);
      return [{ ecosystem: "pypi", name: "evil-pkg", version: "1.0.0", code: "blocked" }];
    };
    const result = await runCommand("exit 1", 5_000, f.workspace, f.setup, { spawn: f.spawn, lookup });
    assert.equal(result.code, 1);
    assert.match(result.output, /evil-pkg/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].token, FAKE_PIP_PASSWORD);
  } finally {
    await f.cleanup();
  }
});

test("prepares the workspace locally before forwarding (setup files and TMPDIR)", async () => {
  const f = await fixture("forward");
  try {
    const result = await runCommand('test -d "$TMPDIR" && printf ok', 5_000, f.workspace, f.setup, { spawn: f.spawn });
    assert.deepEqual(result, { code: 0, output: "ok" });
  } finally {
    await f.cleanup();
  }
});

for (const [mode, line] of [
  ["setupFailed", "wardby-cmd: toolchain_setup_failed"],
  ["shell", "wardby-cmd: toolchain_unusable:shell"],
  ["agent", "wardby-cmd: toolchain_unusable:agent"],
  ["lost", "wardby-cmd: connection lost"],
]) {
  test(`surfaces the client's "${line}" as exactly that fixed text, nothing else from the agent`, async () => {
    const f = await fixture(mode, { env: { PIP_INDEX_URL: FAKE_PIP_INDEX_URL } });
    try {
      let looked = false;
      const result = await runCommand("echo hi", 5_000, f.workspace, f.setup, {
        spawn: f.spawn,
        lookup: async () => {
          looked = true;
          return [{ ecosystem: "pypi", name: "x", version: "1", code: "blocked" }];
        },
      });
      assert.deepEqual(result, { code: 125, output: line });
      assert.equal(looked, false);
    } finally {
      await f.cleanup();
    }
  });
}

test("a command's own exit 125 without a client line is an ordinary failure", async () => {
  const f = await fixture("plain125");
  try {
    const result = await runCommand("true", 5_000, f.workspace, f.setup, { spawn: f.spawn, lookup: async () => [] });
    assert.deepEqual(result, { code: 125, output: "wardby-cmd: something else\n" });
  } finally {
    await f.cleanup();
  }
});

test("a missing client is the fixed toolchain_unusable:agent, never the spawn error", async () => {
  const f = await fixture("forward");
  try {
    const missing = (file, args, options) => nodeSpawn(join(f.dir, "no-such-wardby-cmd"), args, options);
    const result = await runCommand("true", 5_000, f.workspace, f.setup, { spawn: missing, lookup: async () => [] });
    assert.deepEqual(result, { code: 125, output: "wardby-cmd: toolchain_unusable:agent" });
  } finally {
    await f.cleanup();
  }
});

test("lists exactly the client's fixed failure lines", () => {
  assert.deepEqual([...TOOLCHAIN_FAILURES].sort(), [
    "connection lost",
    "toolchain_setup_failed",
    "toolchain_unusable:agent",
    "toolchain_unusable:shell",
  ]);
});

test("secrets: the token and a registry password never reach the spawn's arguments, results or the tool runner's logs", async () => {
  const written = [];
  const capture = (stream) => {
    const original = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      written.push(String(chunk));
      return original(chunk, ...rest);
    };
    return () => (stream.write = original);
  };
  const consoleMethods = ["log", "info", "warn", "error", "debug"];
  const originals = consoleMethods.map((name) => console[name]);
  consoleMethods.forEach((name) => (console[name] = (...args) => written.push(args.map(String).join(" "))));
  const restoreOut = capture(process.stdout);
  const restoreErr = capture(process.stderr);
  const results = [];
  const allCalls = [];
  try {
    for (const mode of ["lost", "setupFailed", "agent", "shell", "forward"]) {
      const f = await fixture(mode, { env: { PIP_INDEX_URL: FAKE_PIP_INDEX_URL } });
      try {
        const opts = { spawn: f.spawn, lookup: async () => [] };
        results.push(await runCommand("exit 7", 5_000, f.workspace, f.setup, opts));
        results.push(await runCommand("sleep 30", 1_000, f.workspace, f.setup, opts));
        allCalls.push(...f.calls);
      } finally {
        await f.cleanup();
      }
    }
  } finally {
    restoreOut();
    restoreErr();
    consoleMethods.forEach((name, index) => (console[name] = originals[index]));
  }
  const haystack = JSON.stringify(results) + written.join("") + JSON.stringify(allCalls.map((c) => c.args));
  assert.ok(!haystack.includes(FAKE_TOKEN), "token leaked");
  assert.ok(!haystack.includes(FAKE_PIP_PASSWORD), "registry password leaked");
  // The token's content never travels in the environment either (only the setup's own registry value does).
  for (const call of allCalls) assert.ok(!JSON.stringify(call.env).includes(FAKE_TOKEN));
});
