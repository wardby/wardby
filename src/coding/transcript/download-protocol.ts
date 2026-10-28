/**
 * The run transcript download, as the server (mcp/tools/run-transcript-download.ts)
 * serves it and `wardby resume` reads it. Import-free, so the CLI side loads
 * nothing of the server.
 *
 * GET <origin>/run-transcripts/download?t=<signed token>
 *   200: body = the stored gzip object; headers:
 *     x-wardby-sha256           sha256 (hex) of the body
 *     x-wardby-session-id       the Claude Code session id
 *     x-wardby-transcript-meta  base64url JSON TranscriptDownloadMeta
 *   otherwise: JSON { "error": <DownloadRefusal> }
 */
export const RUN_TRANSCRIPT_DOWNLOAD_PATH = "/run-transcripts/download";
/** How long a download link works. */
export const RUN_TRANSCRIPT_LINK_TTL_MS = 10 * 60_000;

export const TRANSCRIPT_SHA256_HEADER = "x-wardby-sha256";
export const TRANSCRIPT_SESSION_HEADER = "x-wardby-session-id";
export const TRANSCRIPT_META_HEADER = "x-wardby-transcript-meta";

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

export type DownloadRefusal =
  "link_invalid" | "not_found" | "transcript_expired" | "transcript_unavailable" | "transcript_corrupt";
