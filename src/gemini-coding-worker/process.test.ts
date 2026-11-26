import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnGeminiCli, STDERR_TAIL_BYTES, STDOUT_LINE_MAX_BYTES } from "./process.js";

let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** A stand-in CLI: prints its arguments and an env value as events, floods stderr, exits with $1. */
async function fakeCli(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "wardby-fake-gemini-"));
  const path = join(root, "gemini.js");
  await writeFile(
    path,
    `const [code, ...rest] = process.argv.slice(2);
console.log(JSON.stringify({ type: "init", args: rest, home: process.env.HOME }));
process.stderr.write("key=" + (process.env.GEMINI_API_KEY ?? "") + "\\n");
process.stderr.write("x".repeat(${STDERR_TAIL_BYTES} * 2) + "END");
if (code === "hang") setInterval(() => {}, 1000); else process.exit(Number(code));`,
  );
  return path;
}

describe("spawnGeminiCli", () => {
  it("streams stdout lines, keeps a bounded stderr tail and reports the exit code", async () => {
    const run = spawnGeminiCli(await fakeCli())(["7", "-p", "hi"], {
      cwd: tmpdir(),
      env: { HOME: "/h", PATH: process.env.PATH ?? "" },
      signal: new AbortController().signal,
    });
    const lines: string[] = [];
    for await (const line of run.lines) lines.push(line);
    const done = await run.done;
    expect(JSON.parse(lines[0])).toEqual({ type: "init", args: ["-p", "hi"], home: "/h" });
    expect(done.code).toBe(7);
    expect(Buffer.byteLength(done.stderrTail)).toBeLessThanOrEqual(STDERR_TAIL_BYTES);
    expect(done.stderrTail.endsWith("END")).toBe(true);
  });

  it("stops the CLI when the run is cancelled", async () => {
    const controller = new AbortController();
    const run = spawnGeminiCli(await fakeCli())(["hang"], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    for await (const _ of run.lines) void _;
    expect((await run.done).signal).toBe("SIGTERM");
  });

  it("never spawns the CLI when the run is already cancelled", async () => {
    const path = await fakeCli();
    const marker = join(root!, "started");
    await writeFile(path, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1");`);
    const controller = new AbortController();
    controller.abort();
    const run = spawnGeminiCli(path)(["0"], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
      signal: controller.signal,
    });
    const lines: string[] = [];
    for await (const line of run.lines) lines.push(line);
    expect(lines).toEqual([]);
    expect(await run.done).toEqual({ code: null, signal: null, stderrTail: "", oversizedLines: 0 });
    await expect(stat(marker)).rejects.toThrow();
  });

  it("kills the whole process group: a relaunched child that inherits stdio and ignores SIGTERM", async () => {
    const path = await fakeCli();
    const grandchild = join(root!, "grandchild.js");
    await writeFile(grandchild, `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`);
    // Like 0.70.0's relaunch: the parent forwards nothing, the child inherits stdio, both ignore SIGTERM.
    await writeFile(
      path,
      `const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "inherit" });
console.log(JSON.stringify({ type: "init" }));
setInterval(() => {}, 1000);`,
    );
    const controller = new AbortController();
    const run = spawnGeminiCli(path, { killGraceMs: 200 })(["x"], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    for await (const _ of run.lines) void _;
    expect((await run.done).signal).toBe("SIGKILL");
  }, 10_000);

  it("ends when the CLI exits even if a process it left behind still holds stdout", async () => {
    const path = await fakeCli();
    const grandchild = join(root!, "grandchild.js");
    await writeFile(grandchild, `setInterval(() => {}, 1000);`);
    await writeFile(
      path,
      `const { spawn } = require("node:child_process");
spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "inherit" });
console.log(JSON.stringify({ type: "result" }));
setTimeout(() => process.exit(3), 100);`,
    );
    const run = spawnGeminiCli(path)(["x"], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
      signal: new AbortController().signal,
    });
    const lines: string[] = [];
    for await (const line of run.lines) lines.push(line);
    expect(lines).toEqual(['{"type":"result"}']);
    expect((await run.done).code).toBe(3);
  }, 10_000);

  it("drops a stdout line over the cap whole, counts it, and keeps the lines around it", async () => {
    const path = await fakeCli();
    await writeFile(
      path,
      `process.stdout.write('{"type":"init"}\\n');
const big = "y".repeat(${STDOUT_LINE_MAX_BYTES} + 1);
process.stdout.write(big.slice(0, 1000));
process.stdout.write(big.slice(1000) + "\\n");
process.stdout.write('{"type":"result"}\\r\\n', () => process.exit(0));`,
    );
    const run = spawnGeminiCli(path)(["x"], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
      signal: new AbortController().signal,
    });
    const lines: string[] = [];
    for await (const line of run.lines) lines.push(line);
    expect(lines).toEqual(['{"type":"init"}', '{"type":"result"}']);
    expect((await run.done).oversizedLines).toBe(1);
  }, 20_000);

  it("passes a line at exactly the cap", async () => {
    const path = await fakeCli();
    await writeFile(path, `process.stdout.write("z".repeat(${STDOUT_LINE_MAX_BYTES}), () => process.exit(0));`);
    const run = spawnGeminiCli(path)(["x"], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
      signal: new AbortController().signal,
    });
    const lengths: number[] = [];
    for await (const line of run.lines) lengths.push(line.length);
    expect(lengths).toEqual([STDOUT_LINE_MAX_BYTES]);
    expect((await run.done).oversizedLines).toBe(0);
  }, 20_000);

  it("passes exactly the given environment, and the CLI's output reaches no driver stream", async () => {
    const capability = "rrp_FAKEcapability0123456789";
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    const run = spawnGeminiCli(await fakeCli())(["0"], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "", GEMINI_API_KEY: capability },
      signal: new AbortController().signal,
    });
    for await (const _ of run.lines) void _;
    // The stderr tail itself may carry secrets (this fake prints the key to stderr): the runner only
    // returns it to the caller; redaction by exact value is the debug trace's job (decision 19).
    await run.done;
    for (const spy of [stdout, stderr, log, error]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(capability);
    }
  });

  it("a spawn failure rejects done instead of throwing elsewhere", async () => {
    const run = spawnGeminiCli("/nonexistent/gemini.js")(["0"], {
      cwd: join(tmpdir(), "wardby-no-such-dir-for-gemini"),
      env: { PATH: process.env.PATH ?? "" },
      signal: new AbortController().signal,
    });
    for await (const _ of run.lines) void _;
    await expect(run.done).rejects.toThrow();
  });

  it("keeps enough stderr to hold line 1 of the recorded unknown-flag failure", async () => {
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/stream/unknown-flag.json", import.meta.url), "utf8"),
    ) as { stderrTail: string };
    expect(fixture.stderrTail).toContain("Unknown argument");
    expect(STDERR_TAIL_BYTES).toBeGreaterThanOrEqual(Buffer.byteLength(fixture.stderrTail, "utf8"));
  });
});
