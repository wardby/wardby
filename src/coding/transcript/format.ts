export const TRANSCRIPT_FORMAT_VERSION = 1;
/** The largest sanitised transcript file the worker writes (uncompressed). */
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
/** The default cap on a stored transcript before compression (RUN_TRANSCRIPT_MAX_BYTES). */
export const DEFAULT_TRANSCRIPT_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_RAW_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

export type TranscriptProvider = "claude-code";
export type TranscriptHeaderStatus = "ok" | "too_large" | "no_complete_turn";

export interface TranscriptHeader {
  type: "wardby-transcript";
  version: 1;
  provider: TranscriptProvider;
  sessionId: string;
  status: TranscriptHeaderStatus;
}

export function formatTranscriptFile(header: TranscriptHeader, lines: readonly string[]): string {
  return [JSON.stringify(header), ...lines].join("\n") + "\n";
}

export function parseTranscriptFile(text: string): { header: TranscriptHeader; body: string } | null {
  const newline = text.indexOf("\n");
  const first = newline < 0 ? text : text.slice(0, newline);
  let header: unknown;
  try {
    header = JSON.parse(first);
  } catch {
    return null;
  }
  if (!isHeader(header)) return null;
  return { header, body: newline < 0 ? "" : text.slice(newline + 1) };
}

function isHeader(value: unknown): value is TranscriptHeader {
  const v = value as Partial<TranscriptHeader> | null;
  return (
    !!v &&
    v.type === "wardby-transcript" &&
    v.version === TRANSCRIPT_FORMAT_VERSION &&
    v.provider === "claude-code" &&
    typeof v.sessionId === "string" &&
    (v.status === "ok" || v.status === "too_large" || v.status === "no_complete_turn")
  );
}
