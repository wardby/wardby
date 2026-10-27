import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTranscriptFile } from "../coding/transcript/format.js";
import { writeWorkerTranscript, writeWorkerTranscriptWithLimit } from "./transcript.js";

const SESSION = "00000000-0000-4000-8000-000000000001";
const fixture = await readFile(new URL("../coding/transcript/fixtures/claude-session.jsonl", import.meta.url), "utf8");

async function setup(content?: string) {
  const configDir = await mkdtemp(join(tmpdir(), "cfg-"));
  const outDir = await mkdtemp(join(tmpdir(), "out-"));
  if (content !== undefined) {
    const projectDir = join(configDir, "projects", "-opt-wardby-empty-workspace");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${SESSION}.jsonl`), content);
  }
  return { configDir, outDir, outputPath: join(outDir, "session.jsonl") };
}

describe("writeWorkerTranscript", () => {
  it("writes a header and the sanitised records", async () => {
    const { configDir, outputPath } = await setup(fixture);
    await writeWorkerTranscript({ configDir, sessionId: SESSION, outputPath });
    const parsed = parseTranscriptFile(await readFile(outputPath, "utf8"))!;
    expect(parsed.header).toEqual({
      type: "wardby-transcript",
      version: 1,
      provider: "claude-code",
      sessionId: SESSION,
      status: "ok",
    });
    expect(parsed.body).not.toContain("person@example.com");
  });

  it("writes a too_large header with no records when the sanitised transcript exceeds the cap", async () => {
    const { configDir, outputPath } = await setup(fixture);
    await writeWorkerTranscriptWithLimit({ configDir, sessionId: SESSION, outputPath }, 10);
    const raw = await readFile(outputPath, "utf8");
    const parsed = parseTranscriptFile(raw)!;
    expect(parsed.header.status).toBe("too_large");
    expect(parsed.body).toBe("");
  });

  it("writes a no_complete_turn header when nothing can be resumed", async () => {
    const { configDir, outputPath } = await setup('{"type":"queue-operation","operation":"enqueue"}\n');
    await writeWorkerTranscript({ configDir, sessionId: SESSION, outputPath });
    expect(parseTranscriptFile(await readFile(outputPath, "utf8"))!.header.status).toBe("no_complete_turn");
  });

  it("writes nothing when the session file is missing", async () => {
    const { configDir, outDir, outputPath } = await setup();
    await writeWorkerTranscript({ configDir, sessionId: SESSION, outputPath });
    expect(await readdir(outDir)).toEqual([]);
  });

  it("writes nothing for a session id that is not a UUID", async () => {
    const { configDir, outDir, outputPath } = await setup(fixture);
    await writeWorkerTranscript({ configDir, sessionId: "../x", outputPath });
    expect(await readdir(outDir)).toEqual([]);
  });

  it("leaves no temporary file behind", async () => {
    const { configDir, outDir, outputPath } = await setup(fixture);
    await writeWorkerTranscript({ configDir, sessionId: SESSION, outputPath });
    expect(await readdir(outDir)).toEqual(["session.jsonl"]);
  });
});
