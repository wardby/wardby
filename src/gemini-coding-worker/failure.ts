import { streamFailureCode, WORKER_AGENT_CLI_INCOMPATIBLE } from "../coding-worker/errors.js";
import { geminiError, type GeminiResult } from "./stream.js";

export interface GeminiExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type GeminiRunEnd = { kind: "ok" } | { kind: "budget_exhausted" } | { kind: "failed"; code: string };

const failed = (code: string): GeminiRunEnd => ({ kind: "failed", code });
/**
 * The coding proxy's mark on an upstream quota refusal (providers/coding-proxy/gemini-refusal.ts;
 * the image carries no proxy code, so a test keeps the literal equal).
 */
export const GEMINI_QUOTA_MARKER = "upstream_quota_exceeded";
/** The CLI's fatal configuration exits (41 auth, 42 input, 52 config, 55 sandbox/settings). */
const CONFIG_EXITS = new Set([41, 42, 52, 55]);
/**
 * yargs' first stderr line when the command line is refused (the help text follows it). Needs the
 * runner's stderr tail to still hold stderr line 1: the recorded unknown-flag stderr is ~4.2 KiB and
 * the runner keeps 16 KiB (decision 19).
 */
const REFUSED_ARGUMENTS = /Unknown arguments?:|Not enough non-option arguments|Invalid values:/;

/**
 * How a CLI run ended, from its exit code, its last `result` event and (only without one) its
 * stderr tail (spec §3 exit-code table; recorded in fixtures/stream). API errors exit with the HTTP
 * status mod 256; the message, never the type ("Error"), tells them apart. Stderr is matched on
 * message text only, never on bundle file names or line numbers. Only fixed codes leave.
 */
export function geminiRunEnd(exit: GeminiExit, result: GeminiResult | undefined, stderrTail: string): GeminiRunEnd {
  const message = result?.status === "error" ? (result.error?.message ?? "") : "";
  // The proxy's own refusal: work is kept (as #380). Checked first, whatever the exit.
  if (
    message.includes("wardby_budget_exhausted") ||
    (exit.code === 173 && stderrTail.includes("wardby_budget_exhausted"))
  ) {
    return { kind: "budget_exhausted" };
  }
  if (exit.code === 0) {
    // Fail closed: a clean exit is a success only when its result event says so (not when it says
    // error, and not when the stream ended without one).
    return result?.status === "success" ? { kind: "ok" } : failed("coding_stream_agent_exited");
  }
  if (exit.signal !== null || exit.code === null) return failed("coding_stream_agent_exited");
  // The provider account's quota or spend limit (the proxy relays it marked, with limit: 0, so the
  // CLI does not retry): only an operator can fix it, whatever the status.
  if (
    message.includes(GEMINI_QUOTA_MARKER) ||
    (exit.code === 173 && !result && stderrTail.includes(GEMINI_QUOTA_MARKER))
  ) {
    return failed("coding_stream_quota_exceeded");
  }
  if (exit.code === 53 || result?.error?.type === "FatalTurnLimitedError") return failed("coding_turn_limit");
  if (CONFIG_EXITS.has(exit.code)) return failed(WORKER_AGENT_CLI_INCOMPATIBLE);
  const byMessage = streamFailureCode(new Error(message));
  if (exit.code === 173) {
    return failed(byMessage === "coding_stream_quota_exceeded" ? byMessage : "coding_stream_rate_limited");
  }
  if (exit.code === 145 || exit.code === 147) return failed("coding_stream_proxy_denied");
  if (exit.code === 144) return failed("coding_stream_upstream_error");
  // 500..511 mod 256 (500 → 244, 503 → 247).
  if (exit.code >= 244 && exit.code <= 255) return failed("coding_stream_upstream_error");
  if (exit.code === 1) {
    if (message.startsWith("[API Error")) {
      return failed(byMessage === "coding_stream_failed" ? "coding_stream_upstream_error" : byMessage);
    }
    if (!result && REFUSED_ARGUMENTS.test(stderrTail)) return failed(WORKER_AGENT_CLI_INCOMPATIBLE);
  }
  return failed("coding_stream_agent_exited");
}

/** `--output-format json` (the repair turn): `{ session_id, response, stats }` or an error document. */
export function jsonOutputResult(stdout: string): { response?: string; result?: GeminiResult } {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const document = value as { response?: unknown; error?: unknown };
  if (typeof document.response === "string") return { response: document.response, result: { status: "success" } };
  const error = geminiError(document.error);
  return error ? { result: { status: "error", error } } : {};
}
