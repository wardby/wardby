import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The one property that matters: this logger must never write to stdout.
 * stdout is the JSON-RPC wire in stdio MCP mode — a stray log line there
 * corrupts every connected client's protocol stream. Spawns a real
 * subprocess so stdout/stderr are genuinely separate file descriptors,
 * not mocked streams.
 */
describe("logger", () => {
  it("writes log output to stderr only, never stdout", () => {
    const dir = mkdtempSync(join(tmpdir(), "wardby-logger-test-"));
    const script = join(dir, "log-once.mjs");
    writeFileSync(
      script,
      `import { logger } from ${JSON.stringify(join(import.meta.dirname, "logger.ts"))};\nlogger.info("hello from the logger test");\n`,
    );
    const result = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("hello from the logger test");
  });
});
