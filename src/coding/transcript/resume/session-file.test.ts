import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSessionFile } from "./session-file.js";
import { BODY, meta, RUN_ID, SESSION_ID, transcriptGzip } from "./resume.test-support.js";

const root = () => mkdtempSync(join(tmpdir(), "wardby-sessions-"));
const transcript = (body = BODY) => {
  const gzip = transcriptGzip(body);
  return { gzip, meta: meta({}, gzip) };
};

describe("writeSessionFile", () => {
  it("writes the body without the header to <root>/<runId>/<sessionId>.jsonl, mode 0600", async () => {
    const dir = root();
    const result = await writeSessionFile(transcript(), { root: dir });
    expect(result.path).toBe(join(dir, RUN_ID, `${SESSION_ID}.jsonl`));
    expect(result.outcome).toBe("written");
    expect(readFileSync(result.path, "utf8")).toBe(BODY);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    // No temp file left behind.
    expect(readdirSync(join(dir, RUN_ID))).toEqual([`${SESSION_ID}.jsonl`]);
  });

  it("reuses an identical file and keeps a local continuation", async () => {
    const dir = root();
    const first = await writeSessionFile(transcript(), { root: dir });
    expect((await writeSessionFile(transcript(), { root: dir })).outcome).toBe("same");
    writeFileSync(first.path, BODY + '{"type":"user","message":{"content":"local turn"}}\n');
    const again = await writeSessionFile(transcript(), { root: dir });
    expect(again.outcome).toBe("continued");
    expect(readFileSync(first.path, "utf8")).toContain("local turn");
  });

  it("refuses to replace a different file unless forced", async () => {
    const dir = root();
    const first = await writeSessionFile(transcript(), { root: dir });
    writeFileSync(first.path, "something else\n");
    await expect(writeSessionFile(transcript(), { root: dir })).rejects.toThrow(
      /different session file already exists/,
    );
    expect(readFileSync(first.path, "utf8")).toBe("something else\n");
    const forced = await writeSessionFile(transcript(), { root: dir, force: true });
    expect(forced.outcome).toBe("replaced");
    expect(readFileSync(first.path, "utf8")).toBe(BODY);
  });

  it("refuses unsafe ids, a header for another session, and bytes that are not a transcript", async () => {
    const dir = root();
    const t = transcript();
    await expect(writeSessionFile({ ...t, meta: { ...t.meta, runId: "../x" } }, { root: dir })).rejects.toThrow(
      /invalid run details/,
    );
    await expect(
      writeSessionFile({ ...t, meta: { ...t.meta, sessionId: "99999999-2222-4333-8444-555555555555" } }, { root: dir }),
    ).rejects.toThrow(/not one wardby resume can load/);
    await expect(writeSessionFile({ ...t, gzip: Buffer.from("plain") }, { root: dir })).rejects.toThrow(
      /could not be decompressed/,
    );
  });
});
