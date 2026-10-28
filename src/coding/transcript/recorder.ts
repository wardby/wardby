import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { PrismaClient } from "#prisma";
import { BlobStoreError, type BlobStore } from "../../providers/storage/types.js";
import { withEscapedForms } from "../../core/secret-spans.js";
import { REDACTED, redactSecrets } from "../redact.js";
import { sanitizeClaudeTranscript } from "./claude-code.js";
import {
  DEFAULT_TRANSCRIPT_MAX_BYTES,
  formatTranscriptFile,
  MAX_TRANSCRIPT_BYTES,
  parseTranscriptFile,
} from "./format.js";

export type TranscriptStatus = "stored" | "too_large" | "not_captured" | "failed";
/** What `record` reports to its caller: the row's status, or that the row itself was lost. */
export type RecordResult = TranscriptStatus | "row_write_failed";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The stored object: the transcript file, gzip-compressed. */
export function transcriptBlobKey(runId: string): string {
  return `run-transcripts/${runId}.jsonl.gz`;
}

const MIN_TRANSCRIPT_MAX_BYTES = 1024 * 1024;

/** RUN_TRANSCRIPT_MAX_BYTES: the largest transcript stored, measured before compression. */
export function loadTranscriptMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RUN_TRANSCRIPT_MAX_BYTES?.trim();
  if (!raw) return DEFAULT_TRANSCRIPT_MAX_BYTES;
  const bytes = Number(raw);
  if (!Number.isInteger(bytes) || bytes < MIN_TRANSCRIPT_MAX_BYTES || bytes > MAX_TRANSCRIPT_BYTES) {
    throw new Error(
      `RUN_TRANSCRIPT_MAX_BYTES must be a whole number of bytes from ${MIN_TRANSCRIPT_MAX_BYTES} to ${MAX_TRANSCRIPT_BYTES}.`,
    );
  }
  return bytes;
}

export function loadTranscriptRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RUN_TRANSCRIPT_RETENTION_DAYS?.trim();
  if (!raw) return 30;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error("RUN_TRANSCRIPT_RETENTION_DAYS must be a whole number of days from 1 to 3650.");
  }
  return days;
}

export interface RunTranscriptRecorderDeps {
  db: { runTranscript: Pick<PrismaClient["runTranscript"], "upsert" | "findMany" | "deleteMany"> };
  blobs: BlobStore | undefined;
  /**
   * The agent's attached secret values; rejects when any can't be loaded. The run capability (rrp_) and the
   * registry token derived from it (rrg_) are not listed: they have fixed token shapes that redactSecrets
   * (redact.ts) removes whatever their value, and the vault no longer holds the capability by now.
   */
  secretValues: (agentId: string) => Promise<string[]>;
  retentionDays: number;
  /** The largest transcript stored, before compression (loadTranscriptMaxBytes). */
  maxBytes: number;
  now?: () => Date;
}

export interface RecordTranscriptInput {
  runId: string;
  agentId: string;
  provider: string;
  read: (maxBytes: number) => Promise<string | undefined>;
}

/**
 * Stores a coding run's session transcript for local resume. The worker's file is not trusted: it is
 * sanitised again here, then every string in each record (values and object keys) is redacted by exact
 * value against the agent's attached secret values (and their JSON-escaped forms); the run capability
 * (rrp_) and the registry token (rrg_) are removed by their fixed token shape. Only that copy is stored.
 * Rows carry fixed codes, never content. Never throws.
 */
export class RunTranscriptRecorder {
  constructor(private readonly deps: RunTranscriptRecorderDeps) {}

  /**
   * Returns the stored status, or `row_write_failed` when the row could not be written (the caller logs
   * that code with the run id; the error itself is never surfaced, as it may quote content).
   */
  async record(input: RecordTranscriptInput): Promise<RecordResult> {
    const outcome = await this.capture(input).catch(() => ({ status: "failed" as const, reason: "unexpected" }));
    const rowWritten = await this.writeRow(input, outcome).then(
      () => true,
      () => false,
    );
    if (outcome.status === "stored") await this.pruneExpired().catch(() => 0);
    return rowWritten ? outcome.status : "row_write_failed";
  }

  private async capture(input: RecordTranscriptInput): Promise<Outcome> {
    const { blobs } = this.deps;
    if (!blobs) return { status: "not_captured", reason: "no_blob_store" };
    if (input.provider !== "claude-code") return { status: "not_captured", reason: "provider_unsupported" };
    let text: string | undefined;
    try {
      text = await input.read(this.deps.maxBytes);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "transcript_too_large";
      return tooLarge ? { status: "too_large" } : { status: "not_captured", reason: "unreadable" };
    }
    if (text === undefined) return { status: "not_captured", reason: "missing" };
    const file = parseTranscriptFile(text);
    if (!file) return { status: "failed", reason: "invalid_file" };
    if (!SESSION_ID.test(file.header.sessionId)) return { status: "failed", reason: "invalid_file" };
    if (file.header.status === "too_large") return { status: "too_large", sessionId: file.header.sessionId };
    if (file.header.status === "no_complete_turn") {
      return { status: "not_captured", reason: "no_complete_turn", sessionId: file.header.sessionId };
    }
    const sanitized = sanitizeClaudeTranscript(file.body);
    if (!sanitized) return { status: "not_captured", reason: "no_complete_turn", sessionId: file.header.sessionId };
    if (!SESSION_ID.test(sanitized.sessionId)) return { status: "failed", reason: "invalid_file" };
    let secrets: string[];
    try {
      secrets = await this.deps.secretValues(input.agentId);
    } catch {
      return { status: "failed", reason: "secrets_unavailable" };
    }
    const escaped = withEscapedForms(secrets);
    let lines: string[];
    try {
      lines = sanitized.lines.map((line) => redactJsonLine(line, escaped));
    } catch {
      return { status: "failed", reason: "redaction_broke_record" };
    }
    // Guard: every stored line must still be one JSON record.
    for (const line of lines) {
      try {
        JSON.parse(line);
      } catch {
        return { status: "failed", reason: "redaction_broke_record" };
      }
    }
    const body = Buffer.from(
      formatTranscriptFile(
        {
          type: "wardby-transcript",
          version: 1,
          provider: "claude-code",
          sessionId: sanitized.sessionId,
          status: "ok",
        },
        lines,
      ),
    );
    if (body.byteLength > this.deps.maxBytes) return { status: "too_large", sessionId: sanitized.sessionId };
    const stored = gzipSync(body);
    const blobKey = transcriptBlobKey(input.runId);
    try {
      await blobs.put(blobKey, stored, { contentType: "application/gzip" });
    } catch {
      return { status: "failed", reason: "store_failed", sessionId: sanitized.sessionId };
    }
    // Size and hash are of the stored (compressed) bytes, for the importer to verify its download.
    return {
      status: "stored",
      sessionId: sanitized.sessionId,
      blobKey,
      sizeBytes: stored.byteLength,
      sha256: createHash("sha256").update(stored).digest("hex"),
    };
  }

  private async writeRow(input: RecordTranscriptInput, outcome: Outcome): Promise<void> {
    const now = (this.deps.now ?? (() => new Date()))();
    const data = {
      provider: input.provider,
      status: outcome.status,
      reason: outcome.reason ?? null,
      sessionId: outcome.sessionId ?? null,
      blobKey: outcome.blobKey ?? null,
      sizeBytes: outcome.sizeBytes ?? null,
      sha256: outcome.sha256 ?? null,
      expiresAt: new Date(now.getTime() + this.deps.retentionDays * DAY_MS),
    };
    await this.deps.db.runTranscript.upsert({
      where: { runId: input.runId },
      create: { runId: input.runId, ...data },
      update: data,
    });
  }

  async pruneExpired(limit = 20): Promise<number> {
    const now = (this.deps.now ?? (() => new Date()))();
    const expired = await this.deps.db.runTranscript.findMany({
      where: { expiresAt: { lt: now } },
      select: { runId: true, blobKey: true },
      orderBy: { expiresAt: "asc" },
      take: limit,
    });
    const deletable: string[] = [];
    for (const row of expired) {
      try {
        if (row.blobKey && this.deps.blobs) await this.deps.blobs.delete(row.blobKey);
        deletable.push(row.runId);
      } catch (error) {
        if (error instanceof BlobStoreError && error.code === "not_found") deletable.push(row.runId);
      }
    }
    if (deletable.length === 0) return 0;
    const { count } = await this.deps.db.runTranscript.deleteMany({ where: { runId: { in: deletable } } });
    return count;
  }
}

/**
 * Redacts every string leaf of one JSON record, then re-serialises it. Redacting the serialised line
 * instead lets token patterns consume JSON escapes (the Bearer pattern eats the backslash of `\"`).
 */
function redactJsonLine(line: string, secrets: readonly string[]): string {
  return JSON.stringify(redactJsonValue(parseNumbersAsSource(line, secrets), secrets));
}

type SourceReviver = (key: string, value: unknown, context: { source?: string }) => unknown;

const NUMERIC = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * Parses one record, replacing any number that holds a secret (a digits-only value written as a
 * JSON number) with the marker. Checks the source text and the numeric value: the sanitiser has
 * already re-serialised the record, so a number too long for a double arrives rounded.
 */
function parseNumbersAsSource(line: string, secrets: readonly string[]): unknown {
  const numericSecrets = secrets.filter((secret) => NUMERIC.test(secret)).map(Number);
  const reviver: SourceReviver = (_key, value, context) => {
    if (typeof value !== "number") return value;
    const source = context.source ?? String(value);
    if (redactSecrets(source, secrets) !== source || numericSecrets.includes(value)) return REDACTED;
    return value;
  };
  return JSON.parse(line, reviver as Parameters<typeof JSON.parse>[1]) as unknown;
}

function redactJsonValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, secrets));
  if (value !== null && typeof value === "object") {
    // A null-prototype object keeps a "__proto__" key as data.
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) out[redactSecrets(key, secrets)] = redactJsonValue(item, secrets);
    return out;
  }
  return value;
}

interface Outcome {
  status: TranscriptStatus;
  reason?: string;
  sessionId?: string;
  blobKey?: string;
  sizeBytes?: number;
  sha256?: string;
}
