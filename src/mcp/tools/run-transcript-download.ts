/**
 * The download behind `get_run_transcript`'s link: a short-lived signed token
 * (the MCP server's requestState codec, so HMAC + expiry) that names one run
 * and the principal it was minted for. Served by both hosts: the HTTP
 * transport's mounted route (streamable-http.ts) and, on stdio, the
 * ephemeral loopback server (stdio-link-host.ts).
 *
 * The token is a bearer capability. It travels only in the `t` query
 * parameter; nothing here logs it, and no response or error echoes it.
 * Every refusal is a fixed code. On download, access is checked again
 * (canReadRun, as get_run) for the principal in the token, so a link stops
 * working when that principal loses access.
 */
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { PrismaClient } from "#prisma";
import type { BlobStore } from "../../providers/storage/types.js";
import { canReadRun } from "./run-access.js";

/** The HTTP-transport route path (see streamable-http.ts); stdio's loopback server uses the same path. */
export const RUN_TRANSCRIPT_DOWNLOAD_PATH = "/run-transcripts/download";
/** How long a download link works (the requestState codec's own TTL is the same 10 minutes). */
export const RUN_TRANSCRIPT_LINK_TTL_MS = 10 * 60_000;

/** Response headers the importer reads (documented in docs/coding-agent-setup.md). */
export const TRANSCRIPT_SHA256_HEADER = "x-wardby-sha256";
export const TRANSCRIPT_SESSION_HEADER = "x-wardby-session-id";
/** base64url of the TranscriptDownloadMeta JSON. */
export const TRANSCRIPT_META_HEADER = "x-wardby-transcript-meta";

export interface RunTranscriptLinkPayload {
  kind: "run-transcript";
  runId: string;
  principalId: string;
  /** The stdio local operator: owner of every run for access checks. */
  operator?: boolean;
  /** Epoch ms after which the link is refused. */
  exp: number;
}

/** What the importer needs besides the bytes: where to check the run out. Ids and refs only, never content. */
export interface TranscriptDownloadMeta {
  runId: string;
  sessionId: string;
  provider: string;
  repository: string;
  headRef: string;
  resultBranch: string | null;
  baseSha: string | null;
  sha256: string;
}

export interface RunTranscriptDownloadDeps {
  verify: (token: string) => Promise<unknown>;
  db: Pick<PrismaClient, "run" | "agent" | "resourceGrant" | "codingRun" | "runTranscript">;
  blobs: BlobStore | undefined;
  now?: () => Date;
}

/** Fixed refusal codes; the body never carries the token or any content. */
export type DownloadRefusal =
  "link_invalid" | "not_found" | "transcript_expired" | "transcript_unavailable" | "transcript_corrupt";

const STATUS: Record<DownloadRefusal, number> = {
  link_invalid: 403,
  not_found: 404,
  transcript_expired: 410,
  transcript_unavailable: 503,
  transcript_corrupt: 500,
};

function refuse(res: ServerResponse, code: DownloadRefusal): void {
  res
    .writeHead(STATUS[code], {
      "content-type": "application/json",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    })
    .end(JSON.stringify({ error: code }));
}

function isPayload(value: unknown): value is RunTranscriptLinkPayload {
  const v = value as Partial<RunTranscriptLinkPayload> | null;
  return (
    !!v &&
    v.kind === "run-transcript" &&
    typeof v.runId === "string" &&
    typeof v.principalId === "string" &&
    typeof v.exp === "number" &&
    (v.operator === undefined || typeof v.operator === "boolean")
  );
}

export async function handleRunTranscriptDownload(
  method: string | undefined,
  token: string | null,
  res: ServerResponse,
  deps: RunTranscriptDownloadDeps,
): Promise<void> {
  if (method !== "GET") {
    res.writeHead(405, { allow: "GET", "cache-control": "no-store" }).end();
    return;
  }
  const now = (deps.now ?? (() => new Date()))();
  let payload: unknown;
  try {
    if (!token) throw new Error("missing");
    payload = await deps.verify(token);
  } catch {
    refuse(res, "link_invalid");
    return;
  }
  if (!isPayload(payload) || payload.exp <= now.getTime()) {
    refuse(res, "link_invalid");
    return;
  }
  const run = await deps.db.run.findUnique({
    where: { id: payload.runId },
    select: { id: true, agentId: true, triggeredById: true },
  });
  if (!run || !(await canReadRun(deps.db, run, { principalId: payload.principalId, operator: payload.operator }))) {
    refuse(res, "not_found");
    return;
  }
  const [row, codingRun] = await Promise.all([
    deps.db.runTranscript.findUnique({ where: { runId: run.id } }),
    deps.db.codingRun.findUnique({
      where: { runId: run.id },
      select: { repository: true, headRef: true, resultBranch: true, baseSha: true, provider: true },
    }),
  ]);
  if (!row || !codingRun || row.status !== "stored" || !row.blobKey || !row.sha256 || !row.sessionId) {
    refuse(res, "not_found");
    return;
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    refuse(res, "transcript_expired");
    return;
  }
  if (!deps.blobs) {
    refuse(res, "transcript_unavailable");
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await deps.blobs.get(row.blobKey);
  } catch {
    refuse(res, "transcript_unavailable");
    return;
  }
  // The stored object must still be what was recorded.
  if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
    refuse(res, "transcript_corrupt");
    return;
  }
  const meta: TranscriptDownloadMeta = {
    runId: run.id,
    sessionId: row.sessionId,
    provider: row.provider,
    repository: codingRun.repository,
    headRef: codingRun.headRef,
    resultBranch: codingRun.resultBranch,
    baseSha: codingRun.baseSha,
    sha256: row.sha256,
  };
  res
    .writeHead(200, {
      "content-type": "application/gzip",
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      [TRANSCRIPT_SHA256_HEADER]: row.sha256,
      [TRANSCRIPT_SESSION_HEADER]: row.sessionId,
      [TRANSCRIPT_META_HEADER]: Buffer.from(JSON.stringify(meta)).toString("base64url"),
    })
    .end(bytes);
}
