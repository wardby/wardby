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

  it("redacts credentials an error's cause chain carries into an { err } log line", () => {
    // pino's default err serializer walks `cause` and folds it into message and
    // stack, so a transport error quoting a tokenised git remote would print
    // verbatim at any of the repo's ~19 { err } sites. Spawned for the same
    // reason as above: the real serializer, through the real destination.
    const dir = mkdtempSync(join(tmpdir(), "wardby-logger-redaction-"));
    const script = join(dir, "log-secret.mjs");
    writeFileSync(
      script,
      [
        `import { logger } from ${JSON.stringify(join(import.meta.dirname, "logger.ts"))};`,
        `const token = "ghs_" + "a".repeat(36);`,
        `const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";`,
        `const cause = new Error("fetch failed for https://x-access-token:" + token + "@github.com/o/r and " + jwt);`,
        `logger.error({ err: new Error("github_api_unavailable", { cause }) }, "outbound call failed");`,
        `logger.flush?.();`,
        `setTimeout(() => {}, 50);`,
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("outbound call failed");
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stderr).not.toContain("ghs_aaaa");
    expect(result.stderr).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });
});
