/**
 * Downloads a run transcript from a get_run_transcript link and verifies it.
 *
 * The link is a bearer credential: it is only ever sent to the server it
 * names, over HTTPS (plain HTTP only to this machine's loopback, where a
 * stdio MCP server serves it), and no message here quotes it.
 */
import { createHash } from "node:crypto";
import {
  RUN_TRANSCRIPT_DOWNLOAD_PATH as DOWNLOAD_PATH,
  TRANSCRIPT_META_HEADER as META_HEADER,
  TRANSCRIPT_SESSION_HEADER as SESSION_HEADER,
  TRANSCRIPT_SHA256_HEADER as SHA256_HEADER,
  type DownloadRefusal,
  type TranscriptDownloadMeta,
} from "../download-protocol.js";
/** Above the server's largest stored transcript (64 MiB before compression). */
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Run ids are cuids; anything else is refused before it names a path. */
const RUN_ID = /^[a-z0-9]{8,64}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export class ResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeError";
  }
}

export type TranscriptMeta = TranscriptDownloadMeta;

export interface DownloadedTranscript {
  meta: TranscriptMeta;
  /** The stored object: gzip bytes, verified against the server's sha256. */
  gzip: Buffer;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Checks the link's shape without echoing it. */
export function parseResumeLink(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ResumeError(
      "That is not a get_run_transcript download link. Copy the whole link from the tool's result.",
    );
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  if (!secure) {
    throw new ResumeError(
      "The download link must use https (or http to this machine). Refusing to send it over plain http.",
    );
  }
  if (url.username || url.password || !url.pathname.endsWith(DOWNLOAD_PATH) || !url.searchParams.get("t")) {
    throw new ResumeError(
      "That is not a get_run_transcript download link. Copy the whole link from the tool's result.",
    );
  }
  return url;
}

const REFUSALS: Record<DownloadRefusal, string> = {
  link_invalid:
    "The link is invalid or has expired (links work for 10 minutes). Call get_run_transcript again for a new one.",
  not_found: "The server has no transcript you can read for this run.",
  transcript_expired: "The run's transcript has been deleted after the server's retention period.",
  transcript_unavailable: "The server could not read the stored transcript. Try again later, or ask your operator.",
  transcript_corrupt: "The stored transcript no longer matches what was recorded; the server refused to send it.",
};

function parseMeta(header: string | null): TranscriptMeta {
  let meta: Partial<TranscriptMeta>;
  try {
    meta = JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8")) as Partial<TranscriptMeta>;
  } catch {
    throw new ResumeError(
      "The server's response is missing the run's details. Is the server running a matching wardby version?",
    );
  }
  const str = (v: unknown) => typeof v === "string";
  const optional = (v: unknown) => v === null || str(v);
  if (
    !meta ||
    !str(meta.runId) ||
    !RUN_ID.test(meta.runId) ||
    !str(meta.sessionId) ||
    !SESSION_ID.test(meta.sessionId) ||
    !str(meta.provider) ||
    !str(meta.repository) ||
    !str(meta.headRef) ||
    !optional(meta.resultBranch) ||
    !optional(meta.baseSha) ||
    !str(meta.sha256) ||
    !SHA256.test(meta.sha256)
  ) {
    throw new ResumeError("The server's response has invalid run details.");
  }
  return meta as TranscriptMeta;
}

export async function downloadTranscript(
  link: URL,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<DownloadedTranscript> {
  let res: Response;
  try {
    res = await fetchImpl(link, { redirect: "error", headers: { accept: "application/gzip" } });
  } catch {
    throw new ResumeError(
      `Could not reach ${link.origin}. Check your connection (for a stdio MCP server: is it still running?).`,
    );
  }
  if (!res.ok) {
    let code = "";
    try {
      code = ((await res.json()) as { error?: unknown }).error as string;
    } catch {
      // Not a wardby refusal body.
    }
    const message = Object.hasOwn(REFUSALS, code) ? REFUSALS[code as DownloadRefusal] : undefined;
    throw new ResumeError(message ?? `The server refused the download (HTTP ${res.status}).`);
  }
  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > MAX_DOWNLOAD_BYTES) throw new ResumeError("The transcript is larger than wardby resume accepts.");
  const gzip = Buffer.from(await res.arrayBuffer());
  if (gzip.byteLength > MAX_DOWNLOAD_BYTES)
    throw new ResumeError("The transcript is larger than wardby resume accepts.");
  const meta = parseMeta(res.headers.get(META_HEADER));
  const sha = createHash("sha256").update(gzip).digest("hex");
  if (res.headers.get(SHA256_HEADER) !== meta.sha256 || sha !== meta.sha256) {
    throw new ResumeError(
      "The downloaded transcript does not match the server's checksum. Nothing was written; try again.",
    );
  }
  if (res.headers.get(SESSION_HEADER) !== meta.sessionId) {
    throw new ResumeError("The server's response has invalid run details.");
  }
  return { meta, gzip };
}
