/**
 * Writes a downloaded transcript where `claude --resume <file>` can load it:
 * `<root>/<runId>/<sessionId>.jsonl` (root: ~/.wardby/sessions), the body
 * without wardby's header line, mode 0600, atomically (temp file + rename).
 * Never writes into a Claude Code config directory, and never replaces a
 * different file unless asked to.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { parseTranscriptFile } from "../format.js";
import { ResumeError, type DownloadedTranscript } from "./download.js";

const gunzipAsync = promisify(gunzip);
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^[a-z0-9]{8,64}$/i;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function defaultSessionsRoot(): string {
  return join(homedir(), ".wardby", "sessions");
}

export interface SessionFile {
  path: string;
  /** The directory that holds the session file and the MCP config. */
  dir: string;
  /** "written": new; "same": identical file already there; "continued": a local continuation kept; "replaced": --force. */
  outcome: "written" | "same" | "continued" | "replaced";
}

export async function writeSessionFile(
  transcript: DownloadedTranscript,
  opts: { root?: string; force?: boolean } = {},
): Promise<SessionFile> {
  const { meta } = transcript;
  // Re-checked here: these name a path.
  if (!RUN_ID.test(meta.runId) || !SESSION_ID.test(meta.sessionId)) {
    throw new ResumeError("The server's response has invalid run details.");
  }
  let text: string;
  try {
    const raw = await gunzipAsync(transcript.gzip, { maxOutputLength: MAX_BODY_BYTES + 1024 * 1024 });
    text = raw.toString("utf8");
  } catch {
    throw new ResumeError("The downloaded transcript could not be decompressed.");
  }
  const file = parseTranscriptFile(text);
  if (!file || file.header.sessionId !== meta.sessionId || file.header.status !== "ok" || !file.body) {
    throw new ResumeError("The downloaded transcript is not one wardby resume can load.");
  }
  const body = Buffer.from(file.body, "utf8");
  const dir = join(opts.root ?? defaultSessionsRoot(), meta.runId);
  const path = join(dir, `${meta.sessionId}.jsonl`);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  let existing: Buffer | undefined;
  try {
    existing = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing) {
    if (existing.equals(body)) return { path, dir, outcome: "same" };
    // Claude Code appends the continued conversation to the file it resumed.
    if (!opts.force && existing.byteLength > body.byteLength && existing.subarray(0, body.byteLength).equals(body)) {
      return { path, dir, outcome: "continued" };
    }
    if (!opts.force) {
      throw new ResumeError(
        `A different session file already exists at ${path}. Nothing was changed. Pass --force to replace it with the downloaded transcript.`,
      );
    }
  }

  const temp = join(dir, `.${meta.sessionId}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temp, { force: true });
    throw error;
  }
  await handle.close();
  await rename(temp, path);
  return { path, dir, outcome: existing ? "replaced" : "written" };
}
