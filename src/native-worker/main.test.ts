import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
