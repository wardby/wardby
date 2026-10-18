import {
  DEFAULT_DEBUG_TRACE_MAX_MB,
  MAX_DEBUG_TRACE_LINE_BYTES,
  MAX_REDACTED_SPAN,
  redactTokenShapedValues,
} from "../coding/protocol.js";
import { deriveRegistryToken } from "../coding/registry/token.js";
import { redactExactSecretValues } from "../core/secret-spans.js";

/**
 * Admin-requested debug trace (CodingTaskInput.debugTrace). When a run is
 * traced, the worker writes every agent stream event (Codex events, Claude Agent
 * SDK messages) and the full text of any stream failure to its own stdout, one JSON line each, so an operator can read
 * why a run failed from the run pod's log. Nothing here reaches the control
 * plane: the launchers only ever parse `{"error": "<code>"}` lines, and a trace
 * line's single top-level key is `debugTrace`.
 *
 * The trace can still carry prompts and repository content; only token-shaped
 * values are redacted. Lines and the per-run total are capped so a runaway
 * stream cannot flood the log.
 */
export { MAX_DEBUG_TRACE_LINE_BYTES };
/** The per-run total when the input sets no cap (CodingTaskInput.debugTraceMaxMb). */
export const MAX_DEBUG_TRACE_TOTAL_BYTES = DEFAULT_DEBUG_TRACE_MAX_MB * 1024 * 1024;

const MAX_DEPTH = 32;
const MAX_CAUSE_DEPTH = 8;
const MAX_ENTRIES = 1000;
const REDACTED = "[REDACTED]";

/** Shapes protocol.ts's list does not cover, or covers only at longer lengths. */
const EXTRA_TOKEN_PATTERNS = [/rrp_[A-Za-z0-9_-]{8,}/g, /rrg_[A-Za-z0-9_-]{8,}/g, /\bBearer\s+[^\s"',;]+/gi];

/** Redacts the given exact secrets, then every token-shaped value. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  // The shared span-union redactor; any non-empty value counts here, as it always has.
  let redacted = redactExactSecretValues(text, secrets, { marker: REDACTED, minLength: 1 });
  redacted = redactTokenShapedValues(redacted);
  return EXTRA_TOKEN_PATTERNS.reduce((value, pattern) => value.replace(pattern, REDACTED), redacted);
}

/** An error as plain data: name, message, stack, code, and its cause chain. */
export function describeError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return { value: error };
  const code = (error as { code?: unknown }).code;
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(error.cause !== undefined && depth < MAX_CAUSE_DEPTH ? { cause: describeError(error.cause, depth + 1) } : {}),
  };
}

export interface DebugTracer {
  record(kind: string, data: unknown): void;
}

export interface DebugTracerOptions {
  runId: string;
  /** Exact values to redact wherever they appear (the run capability, the registry token). */
  secrets: readonly string[];
  write: (line: string) => void;
  now?: () => number;
  maxLineBytes?: number;
  maxTotalBytes?: number;
}

export function createDebugTracer(options: DebugTracerOptions): DebugTracer {
  const maxLineBytes = options.maxLineBytes ?? MAX_DEBUG_TRACE_LINE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_DEBUG_TRACE_TOTAL_BYTES;
  const now = options.now ?? Date.now;
  const secrets = options.secrets.filter((secret) => secret.length > 0);
  let written = 0;
  let stopped = false;

  // Redact first, then cut: a cut could split a credential and keep its front.
  const redact = (text: string) =>
    redactSecrets(text.slice(0, maxLineBytes + MAX_REDACTED_SPAN), secrets).slice(0, maxLineBytes);

  const sanitize = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (typeof value === "string") return redact(value);
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (typeof value !== "object") return value === undefined ? undefined : `[${typeof value}]`;
    if (depth >= MAX_DEPTH) return "[Depth]";
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    try {
      if (value instanceof Error) return sanitize(describeError(value), depth + 1, seen);
      if (Array.isArray(value)) return value.slice(0, MAX_ENTRIES).map((item) => sanitize(item, depth + 1, seen));
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value).slice(0, MAX_ENTRIES)) {
        out[redact(key)] = sanitize(item, depth + 1, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  };

  const line = (kind: string, at: number, data: unknown, truncated = false) =>
    `${JSON.stringify({ debugTrace: { runId: options.runId, at, kind, data, ...(truncated ? { truncated } : {}) } })}\n`;

  return {
    record(kind, data) {
      if (stopped) return;
      const at = now();
      const clean = sanitize(data, 0, new WeakSet());
      let text = line(kind, at, clean);
      if (Buffer.byteLength(text) > maxLineBytes) {
        const serialized = JSON.stringify(clean) ?? "null";
        let keep = Math.min(serialized.length, maxLineBytes);
        for (;;) {
          text = line(kind, at, serialized.slice(0, keep), true);
          const excess = Buffer.byteLength(text) - maxLineBytes;
          if (excess <= 0 || keep === 0) break;
          keep = Math.max(0, keep - excess);
        }
      }
      if (written + Buffer.byteLength(text) > maxTotalBytes) {
        stopped = true;
        options.write(line("limit_reached", at, { maxTotalBytes }));
        return;
      }
      written += Buffer.byteLength(text);
      options.write(text);
    },
  };
}

/** The worker's tracer for this input, or undefined when the run is not traced. */
export function workerDebugTracer(
  input: { runId: string; debugTrace?: boolean; debugTraceMaxMb?: number },
  capability: string,
  write: (line: string) => void,
): DebugTracer | undefined {
  if (input.debugTrace !== true) return undefined;
  return createDebugTracer({
    runId: input.runId,
    secrets: [capability, deriveRegistryToken(capability)],
    write,
    ...(input.debugTraceMaxMb ? { maxTotalBytes: input.debugTraceMaxMb * 1024 * 1024 } : {}),
  });
}
