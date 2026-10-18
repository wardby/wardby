import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { holdsValueFragment } from "../sandbox/secret-fragments.test-support.js";
import type { WorkerInput } from "./protocol.js";
import { WARM_DELIVERY_ALREADY_DELIVERED, WARM_WORKER_UNCLAIMED_EXIT, warmDeliveryCommand } from "./warm-delivery.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const runWorker = (env: Record<string, string>, stdin = "") =>
  spawnSync(process.execPath, ["--import", "tsx", "src/native-worker/main.ts"], {
    cwd: REPO_ROOT,
    env,
    input: stdin,
    encoding: "utf8",
    timeout: 30_000,
  });

describe("native worker entry", () => {
  it("reads its input from NATIVE_WORKER_INPUT_FILE when set, ignoring stdin", () => {
    const file = join(mkdtempSync(join(tmpdir(), "native-input-")), "input.json");
    writeFileSync(file, '{"v":1,"runId":"r"}\n');
    const result = runWorker({ NATIVE_WORKER_INPUT_FILE: file }, "not json at all\n");
    expect(result.status).toBe(1);
    // The file's (schema-invalid) input was read, not stdin's unparseable line.
    expect(result.stderr).toContain("message_invalid");
  });

  it("reads the first stdin line otherwise", () => {
    const result = runWorker({}, "not json at all\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("message_not_json");
  });

  it("as a warm worker, waits for its input file and reads it once delivered", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "native-warm-")), "wardby-input", "input.json");
    const child = spawn(process.execPath, ["--import", "tsx", "src/native-worker/main.ts"], {
      cwd: REPO_ROOT,
      env: { NATIVE_WORKER_INPUT_FILE: file, NATIVE_WORKER_INPUT_WAIT_MS: "20000" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((done) => child.on("exit", done));
    await new Promise((done) => setTimeout(done, 1_500));
    const [command, ...args] = warmDeliveryCommand(file);
    expect(spawnSync(command, args, { input: '{"v":1,"runId":"r"}', encoding: "utf8" }).status).toBe(0);
    expect(await exited).toBe(1);
    expect(stderr).toContain("message_invalid");
  }, 30_000);

  it("as a warm worker, exits 75 when no run claims it within the wait", () => {
    const file = join(mkdtempSync(join(tmpdir(), "native-warm-")), "input.json");
    const result = runWorker({ NATIVE_WORKER_INPUT_FILE: file, NATIVE_WORKER_INPUT_WAIT_MS: "300" });
    expect(result.status).toBe(WARM_WORKER_UNCLAIMED_EXIT);
  });
});

// Obviously fake values: the point is that they never reach stderr, so a failing assertion prints only these.
const FAKE_SECRET = "fake-secret-value-not-real-0001";
const FAKE_SHORT = "fk01"; // Below the redactor's minimum length, as in-process.

const leakInput: WorkerInput = {
  v: 1,
  runId: "run-redact",
  agent: { systemPrompt: "s", model: "claude-haiku-4-5", budgetUsd: 0.5, maxTurns: 4 },
  tools: [{ name: "leak", description: "d", jsonSchema: { type: "object" } }],
  builtinTools: [],
  userTools: {
    leak: { code: 'return [await secrets.get("api"), await secrets.get("short")];', paramsZod: "z.object({})" },
  },
  runsConcurrently: [],
  pricing: {
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
    encoding: "cl100k_base",
    inputPerMTok: 1,
    outputPerMTok: 5,
    cachedInputPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    efforts: [],
    thinkingMode: "none",
  },
};

/**
 * Plays the gateway on the worker's stdio: the model calls `leak`, whose secrets.get calls answer
 * the fake values, then the worker's `finish` fails with an error that quotes them, which the
 * worker does not handle (run_not_drivable), so it exits with that message.
 */
function crashAfterSecret(): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/native-worker/main.ts"], {
    cwd: REPO_ROOT,
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  let streams = 0;
  let buffer = "";
  const send = (frame: unknown) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const { id, request } = JSON.parse(buffer.slice(0, newline)) as {
        id: number;
        request: { method: string; params: { bridge?: string; argsJson?: string } };
      };
      buffer = buffer.slice(newline + 1);
      if (request.method === "llm.stream" && ++streams === 1) {
        send({ id, event: { type: "tool_call", id: "call_1", name: "leak", argsJson: "{}" } });
        send({
          id,
          event: { type: "done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } },
        });
        send({ id, end: true });
      } else if (request.method === "llm.stream") {
        send({
          id,
          event: { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } },
        });
        send({ id, end: true });
      } else if (request.method === "finish") {
        const message = `run stopped while holding ${FAKE_SECRET} and ${FAKE_SHORT}`;
        send({ id, ok: false, error: { code: "run_not_drivable", message } });
      } else if (request.method === "host.call" && request.params.bridge === "__bridge_secretsGet") {
        const [name] = JSON.parse(request.params.argsJson ?? "[]") as string[];
        send({ id, ok: true, result: name === "api" ? FAKE_SECRET : FAKE_SHORT });
      } else if (request.method === "llm.countTokens") {
        send({ id, ok: true, result: 10 });
      } else {
        send({ id, ok: true, result: null });
      }
    }
  });
  send(leakInput);
  return new Promise((done) => child.on("exit", (code) => done({ code, stderr })));
}

describe("native worker stderr redaction", () => {
  it("never writes a secret value it received to stderr, even in its failure line", async () => {
    const { code, stderr } = await crashAfterSecret();
    expect(code).toBe(1);
    expect(stderr).toContain("native sandbox worker failed: run stopped while holding [REDACTED]");
    expect(stderr).not.toContain(FAKE_SECRET);
    // A value below the minimum length is left alone, the same as the in-process console redactor.
    expect(stderr).toContain(` and ${FAKE_SHORT}`);
  }, 30_000);

  it("redacts received secret values from the shared logger's lines in the worker process", () => {
    const script = [
      'import { installStderrRedaction, rememberSecretValue } from "./src/native-worker/stderr-redaction.ts";',
      'import { logger } from "./src/core/logger.ts";',
      "installStderrRedaction();",
      `rememberSecretValue(${JSON.stringify(FAKE_SECRET)});`,
      `logger.error({ err: new Error("bad " + ${JSON.stringify(FAKE_SECRET)}) }, "saw " + ${JSON.stringify(FAKE_SECRET)});`,
      "logger.flush();",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: REPO_ROOT,
      env: {},
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("saw [REDACTED]");
    expect(result.stderr).toContain("bad [REDACTED]");
    expect(result.stderr).not.toContain(FAKE_SECRET);
  });

  it("redacts a secret value written to stderr as a plain Uint8Array", () => {
    const script = [
      'import { installStderrRedaction, rememberSecretValue } from "./src/native-worker/stderr-redaction.ts";',
      "installStderrRedaction();",
      `rememberSecretValue(${JSON.stringify(FAKE_SECRET)});`,
      `process.stderr.write(new Uint8Array(Buffer.from("bytes " + ${JSON.stringify(FAKE_SECRET)} + "\\n")));`,
    ].join("\n");
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: REPO_ROOT,
      env: {},
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("bytes [REDACTED]");
    expect(result.stderr).not.toContain(FAKE_SECRET);
  });

  /** Runs `lines` as a module in a child process with the redaction installed and FAKE_SECRET remembered. */
  const redactingChild = (lines: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        [
          'import { installStderrRedaction, rememberSecretValue } from "./src/native-worker/stderr-redaction.ts";',
          "installStderrRedaction();",
          `rememberSecretValue(${JSON.stringify(FAKE_SECRET)});`,
          `const head = ${JSON.stringify(FAKE_SECRET.slice(0, 12))};`,
          `const tail = ${JSON.stringify(FAKE_SECRET.slice(12))};`,
          ...lines,
        ].join("\n"),
      ],
      { cwd: REPO_ROOT, env: {}, encoding: "utf8", timeout: 30_000 },
    );
  // Assertions compare booleans, so a failure never prints the fake value either.
  const leaks = (stderr: string) => holdsValueFragment(stderr, [FAKE_SECRET]);

  it("redacts a secret value split across two stderr writes", () => {
    const result = redactingChild([
      'process.stderr.write("split " + head);',
      'process.stderr.write(tail + " end\\n");',
    ]);
    expect(result.status).toBe(0);
    expect(leaks(result.stderr)).toBe(false);
    expect(result.stderr).toContain("split [REDACTED] end\n");
  });

  it("redacts a split secret value in a final unterminated line, flushed on exit", () => {
    const result = redactingChild([
      'process.stderr.write("first line\\n");',
      'process.stderr.write("last " + head);',
      "process.stderr.write(tail);",
      "process.exit(0);",
    ]);
    expect(result.status).toBe(0);
    expect(leaks(result.stderr)).toBe(false);
    expect(result.stderr).toBe("first line\nlast [REDACTED]\n");
  });

  it("redacts a secret value split across the write that crosses the bound", () => {
    const result = redactingChild([
      'const { MAX_PENDING_STDERR_CHARS } = await import("./src/native-worker/stderr-redaction.ts");',
      'process.stderr.write("x".repeat(MAX_PENDING_STDERR_CHARS));',
      "process.stderr.write(head);",
      'process.stderr.write(tail + " end\\n");',
    ]);
    expect(result.status).toBe(0);
    expect(leaks(result.stderr)).toBe(false);
    expect(result.stderr.endsWith("[REDACTED] end\n")).toBe(true);
  });

  it("redacts a remembered value holding a newline, split across writes after that newline", () => {
    const multiLine = "fake-multi-line\nsecret-value-0001";
    const result = redactingChild([
      `rememberSecretValue(${JSON.stringify(multiLine)});`,
      `process.stderr.write("a " + ${JSON.stringify(multiLine.slice(0, 16))});`,
      `process.stderr.write(${JSON.stringify(multiLine.slice(16))} + " b\\n");`,
    ]);
    expect(result.status).toBe(0);
    expect(holdsValueFragment(result.stderr, [multiLine])).toBe(false);
    expect(result.stderr).toBe("a [REDACTED] b\n");
  });

  it("keeps byte order when a string write follows an incomplete multi-byte character", () => {
    const result = redactingChild([
      "process.stderr.write(new Uint8Array([0x61, 0x62, 0xc3]));",
      'process.stderr.write("cd\\n");',
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("ab\ufffdcd\n");
  });

  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    it(`flushes the redacted tail on ${signal} and exits ${code}`, () => {
      const result = redactingChild([
        'process.stderr.write("last " + head);',
        "process.stderr.write(tail);",
        "setTimeout(() => {}, 20_000);",
        `process.kill(process.pid, "${signal}");`,
      ]);
      expect(result.status).toBe(code);
      expect(leaks(result.stderr)).toBe(false);
      expect(result.stderr).toBe("last [REDACTED]\n");
    });
  }

  it("emits a pending line past the bound without waiting for its newline, holding a value whole", async () => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        [
          'import { installStderrRedaction, rememberSecretValue, MAX_PENDING_STDERR_CHARS } from "./src/native-worker/stderr-redaction.ts";',
          "installStderrRedaction();",
          `rememberSecretValue(${JSON.stringify(FAKE_SECRET)});`,
          `process.stderr.write("x".repeat(MAX_PENDING_STDERR_CHARS) + ${JSON.stringify(FAKE_SECRET)});`,
          // Stays alive (no newline written, no exit) until the parent closes stdin.
          'process.stdin.on("data", () => {}); process.stdin.on("end", () => process.exit(0));',
        ].join("\n"),
      ],
      { cwd: REPO_ROOT, env: {}, stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderr = "";
    const emitted = new Promise<void>((done) =>
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length >= 64 * 1024) done();
      }),
    );
    const exited = new Promise<number | null>((done) => child.on("exit", done));
    await Promise.race([emitted, exited]);
    // The text before the value was emitted while the child still runs: the bound, not the exit
    // flush, let it out. The value itself is held whole, then flushed redacted at exit.
    expect(child.exitCode).toBeNull();
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(leaks(stderr)).toBe(false);
    expect(stderr.startsWith("x".repeat(1024))).toBe(true);
    expect(stderr.endsWith("[REDACTED]\n")).toBe(true);
  }, 30_000);

  it("masks a self-overlapping value repeated past the bound, then a value completed in the next write", async () => {
    const value = "abababab";
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        [
          'import { installStderrRedaction, rememberSecretValue, MAX_PENDING_STDERR_CHARS } from "./src/native-worker/stderr-redaction.ts";',
          "installStderrRedaction();",
          `rememberSecretValue(${JSON.stringify(value)});`,
          'process.stderr.write("ab".repeat(MAX_PENDING_STDERR_CHARS) + "abab");',
          // The rest of a value that began at the end of the first write.
          'process.stdin.once("data", () => { process.stderr.write("abab\\n"); process.exit(0); });',
        ].join("\n"),
      ],
      { cwd: REPO_ROOT, env: {}, stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderr = "";
    const emitted = new Promise<void>((done) =>
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        done();
      }),
    );
    const exited = new Promise<number | null>((done) => child.on("exit", done));
    await Promise.race([emitted, exited]);
    // Past the bound, the covered text goes out masked while the child still runs; the value's
    // possible start at the end stays held.
    expect(child.exitCode).toBeNull();
    expect(holdsValueFragment(stderr, [value])).toBe(false);
    child.stdin.write("go");
    expect(await exited).toBe(0);
    expect(holdsValueFragment(stderr, [value])).toBe(false);
    expect(stderr.replaceAll("[REDACTED]", "") === "\n").toBe(true);
  }, 30_000);

  it("masks a self-overlapping value repeated past the bound with a partial value at the very end, on exit", () => {
    const value = "abcabcabc";
    const result = redactingChild([
      `rememberSecretValue(${JSON.stringify(value)});`,
      'const { MAX_PENDING_STDERR_CHARS } = await import("./src/native-worker/stderr-redaction.ts");',
      'process.stderr.write("abc".repeat(MAX_PENDING_STDERR_CHARS / 2) + " x abcabca");',
      "process.exit(0);",
    ]);
    expect(result.status).toBe(0);
    expect(holdsValueFragment(result.stderr, [value])).toBe(false);
    expect(result.stderr.replaceAll("[REDACTED]", "") === " x \n").toBe(true);
  });

  it("masks a partial value held at exit (fail closed)", () => {
    const result = redactingChild([
      'process.stderr.write("first line\\n");',
      'process.stderr.write("last " + head);',
      "process.exit(0);",
    ]);
    expect(result.status).toBe(0);
    expect(holdsValueFragment(result.stderr, [FAKE_SECRET])).toBe(false);
    expect(result.stderr === "first line\nlast [REDACTED]\n").toBe(true);
  });

  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    it(`masks a partial value held when ${signal} arrives (fail closed)`, () => {
      const result = redactingChild([
        'process.stderr.write("last " + head);',
        "setTimeout(() => {}, 20_000);",
        `process.kill(process.pid, "${signal}");`,
      ]);
      expect(result.status).toBe(code);
      expect(holdsValueFragment(result.stderr, [FAKE_SECRET])).toBe(false);
      expect(result.stderr === "last [REDACTED]\n").toBe(true);
    });
  }

  it("masks a value split between a string write and a Uint8Array write", () => {
    const result = redactingChild([
      'process.stderr.write("mixed " + head);',
      'process.stderr.write(new Uint8Array(Buffer.from(tail + " end\\n")));',
    ]);
    expect(result.status).toBe(0);
    expect(holdsValueFragment(result.stderr, [FAKE_SECRET])).toBe(false);
    expect(result.stderr === "mixed [REDACTED] end\n").toBe(true);
  });

  it("masks a value split inside one of its multi-byte characters", () => {
    const value = "fake-s\u00e9cret-value-0002";
    const result = redactingChild([
      `rememberSecretValue(${JSON.stringify(value)});`,
      `const bytes = Buffer.from("mb " + ${JSON.stringify(value)} + " end\\n");`,
      // Split between the two bytes of the accented character.
      "const at = bytes.indexOf(0xc3) + 1;",
      "process.stderr.write(new Uint8Array(bytes.subarray(0, at)));",
      "process.stderr.write(new Uint8Array(bytes.subarray(at)));",
    ]);
    expect(result.status).toBe(0);
    expect(holdsValueFragment(result.stderr, [value])).toBe(false);
    expect(result.stderr === "mb [REDACTED] end\n").toBe(true);
  });

  it("masks a value holding a non-BMP character split between the halves of its surrogate pair", () => {
    const value = "fake-\u{1F511}-secret-0003";
    const at = value.indexOf("\u{1F511}") + 1; // between the high and the low surrogate
    const result = redactingChild([
      `rememberSecretValue(${JSON.stringify(value)});`,
      `process.stderr.write("s " + ${JSON.stringify(value)}.slice(0, ${at}));`,
      `process.stderr.write(${JSON.stringify(value)}.slice(${at}) + " end\\n");`,
    ]);
    expect(result.status).toBe(0);
    expect(holdsValueFragment(result.stderr, [value])).toBe(false);
    expect(result.stderr === "s [REDACTED] end\n").toBe(true);
  });

  it("masks a lone high surrogate still held at exit (fail closed)", () => {
    const result = redactingChild(['process.stderr.write("tail \\uD83D");', "process.exit(0);"]);
    expect(result.status).toBe(0);
    expect(result.stderr === "tail [REDACTED]\n").toBe(true);
  });

  it("decodes a DataView chunk through the same byte path, never writing it raw", () => {
    const result = redactingChild([
      'const data = Buffer.from("dv " + head + tail + " end\\n");',
      "process.stderr.write(new DataView(data.buffer, data.byteOffset, data.byteLength));",
    ]);
    expect(result.status).toBe(0);
    expect(leaks(result.stderr)).toBe(false);
    expect(result.stderr === "dv [REDACTED] end\n").toBe(true);
  });

  it("refuses a chunk that is neither a string nor bytes, without its content", () => {
    const result = redactingChild([
      "try { process.stderr.write({ toString: () => head + tail }); } catch (err) { process.stdout.write(String(err instanceof TypeError)); }",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("true");
    expect(leaks(result.stderr)).toBe(false);
  });

  it("masks a value holding a newline when a line cut falls inside it", () => {
    const multiLine = "fake-multi-line\nsecret-value-0001";
    const result = redactingChild([
      `rememberSecretValue(${JSON.stringify(multiLine)});`,
      `process.stderr.write("a " + ${JSON.stringify(multiLine)});`,
      'process.stderr.write(" b\\n");',
    ]);
    expect(result.status).toBe(0);
    expect(holdsValueFragment(result.stderr, [multiLine])).toBe(false);
    expect(result.stderr.replaceAll("[REDACTED]", "") === "a  b\n").toBe(true);
  });

  it("masks a self-overlapping value across the bound cut while more of it arrives", () => {
    const value = "s3cr3ts";
    const result = redactingChild([
      `rememberSecretValue(${JSON.stringify(value)});`,
      'const { MAX_PENDING_STDERR_CHARS } = await import("./src/native-worker/stderr-redaction.ts");',
      'process.stderr.write("y".repeat(MAX_PENDING_STDERR_CHARS - 3) + "s3cr3t");',
      'process.stderr.write("s3cr3ts3cr");',
      'process.stderr.write("3ts end\\n");',
    ]);
    expect(result.status).toBe(0);
    expect(holdsValueFragment(result.stderr, [value])).toBe(false);
    expect(result.stderr.replaceAll("[REDACTED]", "") === `${"y".repeat(64 * 1024 - 3)} end\n`).toBe(true);
  });
});

describe("warm input delivery", () => {
  it("delivers once: a second delivery fails and leaves the first input in place", () => {
    const file = join(mkdtempSync(join(tmpdir(), "native-deliver-")), "wardby-input", "input.json");
    const [command, ...args] = warmDeliveryCommand(file);
    expect(spawnSync(command, args, { input: "first", encoding: "utf8" }).status).toBe(0);
    expect(spawnSync(command, args, { input: "second", encoding: "utf8" }).status).toBe(
      WARM_DELIVERY_ALREADY_DELIVERED,
    );
    expect(readFileSync(file, "utf8")).toBe("first");
  });
});
