import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeCommand, withoutLink } from "./command.js";
import {
  claudeArgs,
  mcpConfig,
  moveNote,
  parseClaudeVersion,
  printableCommand,
  UNKNOWN_VERSION_NOTE,
} from "./launch.js";
import {
  BODY,
  FAKE_TOKEN,
  makeRepo,
  meta,
  RUN_ID,
  serveTranscript,
  SESSION_ID,
  transcriptGzip,
} from "./resume.test-support.js";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

async function setup(repo = makeRepo()) {
  const gzip = transcriptGzip();
  const served = await serveTranscript({
    gzip,
    meta: meta(
      { repository: `local:${repo.dir}`, headRef: "main", resultBranch: "wardby/run-x", baseSha: repo.base },
      gzip,
    ),
  });
  server = served.server;
  const lines: string[] = [];
  const launches: { cwd: string; args: string[] }[] = [];
  const sessionsRoot = mkdtempSync(join(tmpdir(), "wardby-sessions-"));
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const deps = {
    cwd: tmpdir(),
    sessionsRoot,
    out: (line: string) => lines.push(line),
    claudeVersion: async () => "2.1.312 (Claude Code)",
    launch: async (cwd: string, args: string[]) => {
      launches.push({ cwd, args });
      return 0;
    },
  };
  return { repo, link: served.link, lines, launches, sessionsRoot, stdout, deps };
}

function allOutput(lines: string[], stdout: { mock: { calls: unknown[][] } }): string {
  return [...lines, ...stdout.mock.calls.map((call) => String(call[0]))].join("\n");
}

describe("wardby resume", () => {
  it("imports the session, checks the run out and starts claude --resume with the stand-in", async () => {
    const { repo, link, lines, launches, sessionsRoot, stdout, deps } = await setup();
    expect(await resumeCommand([link], deps)).toBe(0);
    const sessionFile = join(sessionsRoot, RUN_ID, `${SESSION_ID}.jsonl`);
    expect(readFileSync(sessionFile, "utf8")).toBe(BODY);
    const configPath = join(sessionsRoot, RUN_ID, "mcp-config.json");
    const checkout = join(repo.dir, "..", `app-run-${RUN_ID.slice(-8)}`);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(mcpConfig({ checkout, from: "/workspace" }));
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(launches).toHaveLength(1);
    expect(launches[0].cwd).toBe(checkout);
    expect(launches[0].args.slice(0, 6)).toEqual([
      "--resume",
      sessionFile,
      "--mcp-config",
      configPath,
      "--system-prompt-snapshot",
      "off",
    ]);
    expect(launches[0].args[6]).toBe("--append-system-prompt");
    expect(launches[0].args[7]).toBe(moveNote({ runId: RUN_ID, ref: "wardby/run-x", from: "/workspace", checkout }));
    const output = allOutput(lines, stdout);
    expect(output).toContain(`Session file: ${sessionFile}`);
    expect(output).toContain(`Checkout:     ${checkout} at wardby/run-x`);
    expect(output).not.toContain(FAKE_TOKEN);
    expect(output).not.toContain(encodeURIComponent(FAKE_TOKEN));
  });

  it("--print prints the command instead of starting claude, and so does a missing claude", async () => {
    const first = await setup();
    expect(await resumeCommand([first.link, "--print"], first.deps)).toBe(0);
    expect(first.launches).toHaveLength(0);
    const printed = String(first.stdout.mock.calls.at(-1)?.[0]);
    expect(printed).toMatch(/^cd .* && claude --resume /);
    expect(printed).not.toContain(FAKE_TOKEN);
    server?.close();

    const second = await setup();
    expect(await resumeCommand([second.link], { ...second.deps, claudeVersion: async () => undefined })).toBe(0);
    expect(second.launches).toHaveLength(0);
    expect(second.lines.join("\n")).toMatch(/claude\) was not found on PATH/);
    // Unknown version: the flag stays in, with a note on removing it for an old Claude Code.
    expect(String(second.stdout.mock.calls.at(-1)?.[0])).toContain("--system-prompt-snapshot off");
    expect(second.lines).toContain(`Note: ${UNKNOWN_VERSION_NOTE}`);
  });

  it("writes nothing when the checkout is refused", async () => {
    const { link, lines, sessionsRoot, deps } = await setup();
    const other = mkdtempSync(join(tmpdir(), "occupied-"));
    expect(await resumeCommand([link, "--dir", other], deps)).toBe(1);
    expect(lines.at(-1)).toMatch(/^wardby resume: .*already exists/);
    expect(() => statSync(join(sessionsRoot, RUN_ID))).toThrow();
  });

  it("removes the link from an unexpected error's message", async () => {
    const { link, lines, stdout, deps } = await setup();
    // An error that is not a ResumeError (a bug, or a file system or spawn failure).
    const code = await resumeCommand([link], {
      ...deps,
      launch: () => Promise.reject(new Error(`launch failed for ${link} (${encodeURIComponent(FAKE_TOKEN)})`)),
    });
    expect(code).toBe(1);
    expect(lines.at(-1)).toBe("wardby resume: launch failed for [link] ([link])");
    expect(allOutput(lines, stdout)).not.toContain(FAKE_TOKEN);
    expect(allOutput(lines, stdout)).not.toContain(encodeURIComponent(FAKE_TOKEN));
    expect(withoutLink(`a ${link} b ${FAKE_TOKEN} c ${encodeURIComponent(FAKE_TOKEN)}`, link)).toBe(
      "a [link] b [link] c [link]",
    );
  });

  it('reads the link from standard input with "-", keeping it out of argv', async () => {
    const { link, lines, launches, stdout, deps } = await setup();
    expect(await resumeCommand(["-"], { ...deps, readLink: async () => `${link}\n` })).toBe(0);
    expect(launches).toHaveLength(1);
    expect(launches[0].args.join(" ")).not.toContain(FAKE_TOKEN);
    expect(allOutput(lines, stdout)).not.toContain(FAKE_TOKEN);
  });

  it("refuses a local: run from a remote link and writes nothing", async () => {
    const { link, lines, sessionsRoot, deps } = await setup();
    const remote = link.replace(/^http:\/\/127\.0\.0\.1:\d+/, "https://wardby.example.com");
    // The remote server is the local test server underneath.
    const viaLocal: typeof globalThis.fetch = (input, init) =>
      globalThis.fetch(
        (input instanceof URL ? input.href : (input as string)).replace(
          "https://wardby.example.com",
          new URL(link).origin,
        ),
        init,
      );
    expect(await resumeCommand([remote], { ...deps, fetch: viaLocal })).toBe(1);
    expect(lines.at(-1)).toMatch(/^wardby resume: local_repository_refused: /);
    expect(() => statSync(join(sessionsRoot, RUN_ID))).toThrow();
  });

  it("prints usage for bad arguments", async () => {
    const lines: string[] = [];
    expect(await resumeCommand([], { out: (l) => lines.push(l) })).toBe(2);
    expect(await resumeCommand(["a", "--dir", "x", "--here"], { out: (l) => lines.push(l) })).toBe(2);
    expect(lines[0]).toMatch(/^usage: wardby resume/);
  });
});

describe("launch arguments", () => {
  it("adds --system-prompt-snapshot off only for Claude Code versions that have it", () => {
    const base = { sessionFile: "/s.jsonl", mcpConfigPath: "/c.json", note: "n" };
    expect(claudeArgs({ ...base, version: parseClaudeVersion("2.1.257 (Claude Code)") })).toContain(
      "--system-prompt-snapshot",
    );
    expect(claudeArgs({ ...base, version: parseClaudeVersion("2.1.256 (Claude Code)") })).not.toContain(
      "--system-prompt-snapshot",
    );
    // Unknown: included (every current release has it).
    expect(claudeArgs({ ...base, version: parseClaudeVersion("unknown") })).toContain("--system-prompt-snapshot");
    expect(claudeArgs({ ...base, version: [3, 0, 0] })).toContain("--append-system-prompt");
  });

  it("quotes the printed command for a POSIX shell", () => {
    expect(printableCommand("/tmp/a b", ["--append-system-prompt", "it's here"])).toBe(
      `cd '/tmp/a b' && claude --append-system-prompt 'it'\\''s here'`,
    );
  });
});
