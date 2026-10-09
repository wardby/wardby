import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
});
