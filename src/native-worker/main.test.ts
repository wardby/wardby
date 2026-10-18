import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
