import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnGeminiCli, STDERR_TAIL_BYTES } from "./process.js";

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

  it("never starts the CLI when the run is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = spawnGeminiCli(await fakeCli())(["hang"], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
      signal: controller.signal,
    });
    for await (const _ of run.lines) void _;
    expect((await run.done).signal).toBe("SIGTERM");
  });

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
