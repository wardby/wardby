import type { Dirent } from "node:fs";
import { readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readBoundedRegularFile } from "../coding-worker/artifact.js";
import { sanitizeClaudeTranscript } from "../coding/transcript/claude-code.js";
import {
  formatTranscriptFile,
  MAX_RAW_TRANSCRIPT_BYTES,
  MAX_TRANSCRIPT_BYTES,
  type TranscriptHeader,
} from "../coding/transcript/format.js";

export const TRANSCRIPT_OUTPUT_PATH = "/run/wardby/output/session.jsonl";

interface WriteOptions {
  configDir: string;
  sessionId: string;
  outputPath: string;
  /** Used when Claude Code wrote no title (the worker turns off the background call that makes one). */
  title?: string;
}

const MAX_TITLE_CHARS = 80;

/** "wardby run <runId>: <first line of the request>", for the session picker. */
export function runTitle(runId: string, task: string): string {
  const request = task.includes("\n\nRequest:\n") ? task.slice(task.lastIndexOf("\n\nRequest:\n") + 11) : task;
  const firstLine = request.split("\n").find((line) => line.trim()) ?? "";
  const title = `wardby run ${runId}: ${firstLine.trim().replace(/\s+/g, " ")}`;
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title;
}

/**
 * Writes the run's sanitised session transcript next to its result, for the control plane to collect
 * (it sanitises and redacts again before storing anything). Writes nothing when the SDK left no
 * session file. Throws only fixed codes.
 */
export function writeWorkerTranscript(options: WriteOptions): Promise<void> {
  return writeWorkerTranscriptWithLimit(options, MAX_TRANSCRIPT_BYTES);
}

export async function writeWorkerTranscriptWithLimit(options: WriteOptions, maxBytes: number): Promise<void> {
  const source = await findSessionFile(options.configDir, options.sessionId);
  if (!source) return;
  const header = (status: TranscriptHeader["status"]): TranscriptHeader => ({
    type: "wardby-transcript",
    version: 1,
    provider: "claude-code",
    sessionId: options.sessionId,
    status,
  });
  let file: string;
  try {
    const raw = await readBoundedRegularFile(source, MAX_RAW_TRANSCRIPT_BYTES, "transcript_too_large");
    const sanitized = sanitizeClaudeTranscript(raw, options.title);
    file = sanitized
      ? formatTranscriptFile(header("ok"), sanitized.lines)
      : formatTranscriptFile(header("no_complete_turn"), []);
  } catch (error) {
    if (!(error instanceof Error && error.message === "transcript_too_large")) {
      throw new Error("transcript_capture_failed", { cause: error });
    }
    file = formatTranscriptFile(header("too_large"), []);
  }
  if (Buffer.byteLength(file) > maxBytes) file = formatTranscriptFile(header("too_large"), []);
  const temporary = `${options.outputPath}.tmp`;
  await writeFile(temporary, file, { mode: 0o600 });
  await rename(temporary, options.outputPath);
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The SDK's file for this session: <configDir>/projects/<encoded cwd>/<sessionId>.jsonl. */
async function findSessionFile(configDir: string, sessionId: string): Promise<string | undefined> {
  // The id comes from the SDK's init message; only a UUID is ever used to build a path.
  if (!SESSION_ID.test(sessionId)) return undefined;
  const projects = join(configDir, "projects");
  const name = `${sessionId}.jsonl`;
  let entries: Dirent[];
  try {
    entries = await readdir(projects, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const files = await readdir(join(projects, entry.name)).catch(() => [] as string[]);
    if (files.includes(name)) return join(projects, entry.name, name);
  }
  return undefined;
}
