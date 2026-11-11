/**
 * What a run hook's tool receives: `{ event, config }`. The event is the
 * stored workflow event (metadata only) under a versioned envelope; the
 * run's final text is added only for a hook allowed to see it, read from the
 * run at delivery time, masked by exact value and cut to a size limit.
 */
import { redactExactSecretValues } from "../secret-spans.js";

/** The most final-text characters a hook receives (GitHub's comment maximum, like other untrusted text). */
export const MAX_HOOK_FINAL_TEXT_CHARS = 65_536;
export const HOOK_FINAL_TEXT_CUT_NOTE =
  "\n\n[This text was cut to fit; the rest is missing. The full text is on the run.]";

/** The run's final text for a hook: masked first, then cut, so no part of a secret survives the cut. */
export function hookFinalText(
  text: string | null,
  redactValues: readonly string[],
): { finalText: string | null; finalTextTruncated: boolean } {
  if (text === null) return { finalText: null, finalTextTruncated: false };
  const masked = redactExactSecretValues(text, redactValues);
  if (masked.length <= MAX_HOOK_FINAL_TEXT_CHARS) return { finalText: masked, finalTextTruncated: false };
  const kept = masked.slice(0, MAX_HOOK_FINAL_TEXT_CHARS - HOOK_FINAL_TEXT_CUT_NOTE.length).trimEnd();
  return { finalText: kept + HOOK_FINAL_TEXT_CUT_NOTE, finalTextTruncated: true };
}

export interface HookEventRow {
  id: string;
  kind: string;
  runId: string | null;
  createdAt: Date;
  payload: unknown;
}

export interface HookEventV1 {
  schemaVersion: 1;
  kind: string;
  eventId: string;
  occurredAt: string;
  agent: { id: string; name: string };
  runId: string | null;
  /** The event kind's own fields (see the run hooks guide). */
  data: Record<string, unknown>;
  finalText?: string | null;
  finalTextTruncated?: boolean;
  /** Set on test_run_hook's synthetic event. */
  test?: true;
}

export function buildHookEvent(
  row: HookEventRow,
  agent: { id: string; name: string },
  finalText?: { finalText: string | null; finalTextTruncated: boolean },
  test = false,
): HookEventV1 {
  const payload = (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>;
  const { kind: _kind, ...data } = payload;
  return {
    schemaVersion: 1,
    kind: row.kind,
    eventId: row.id,
    occurredAt: row.createdAt.toISOString(),
    agent,
    runId: row.runId,
    data,
    ...(finalText ? finalText : {}),
    ...(test ? { test: true as const } : {}),
  };
}
