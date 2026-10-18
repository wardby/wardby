/**
 * The one redactor for exact secret values: every site that masks values it knows (the sandbox
 * console bridge, the native gateway's log, the native worker's stderr, a brokered response, a
 * coding worker's debug trace, git output) goes through these functions. It masks the union of
 * every occurrence of every value, overlapping occurrences included, so no character of any
 * occurrence survives however occurrences overlap (a value such as `abcabcabc` in `abc` x 5).
 *
 * No imports: every worker image (native sandbox, coding driver, Claude coding worker) ships this
 * file next to its callers.
 */

/** Below this length a "secret" is too likely to coincidentally match ordinary log text — not worth the false-positive risk of redacting it. */
export const MIN_REDACTABLE_SECRET_LENGTH = 6;

/** The marker that stands in for each masked span, unless a site passes its own. */
export const REDACTED_MARKER = "[REDACTED]";

export interface RedactOptions {
  /** Replaces each merged span (default REDACTED_MARKER). */
  marker?: string;
  /** Values shorter than this are left alone (default MIN_REDACTABLE_SECRET_LENGTH; an empty value never matches). */
  minLength?: number;
}

/**
 * Each value plus its JSON-escaped form (`JSON.stringify(v).slice(1, -1)`) when that differs: a
 * value holding a quote, a backslash, a newline or a control character appears escaped once it is
 * inside JSON text (a console line, a log line). The one expansion every redaction list goes through.
 */
export function withEscapedForms(values: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    out.add(value);
    out.add(JSON.stringify(value).slice(1, -1));
  }
  return [...out];
}

/**
 * The merged, sorted [start, end) spans of `text` covered by any occurrence of any value, overlapping
 * occurrences included (the search advances by one character, not by the value's length), so a
 * self-overlapping value is covered wherever any occurrence of it lies. Values shorter than
 * `minLength` are ignored. Overlapping or adjacent spans merge.
 */
export function secretSpans(
  text: string,
  values: Iterable<string>,
  minLength = MIN_REDACTABLE_SECRET_LENGTH,
): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const shortest = Math.max(1, minLength);
  for (const value of new Set(values)) {
    if (value.length < shortest) continue;
    for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) spans.push([at, at + value.length]);
  }
  return mergeSpans(spans);
}

/** `spans` sorted and merged, overlapping or adjacent ones joined. */
export function mergeSpans(spans: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = spans.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** `text` with each of the merged, sorted `spans` replaced by one `marker`. */
export function maskSpans(
  text: string,
  spans: ReadonlyArray<readonly [number, number]>,
  marker = REDACTED_MARKER,
): string {
  let out = "";
  let from = 0;
  for (const [start, end] of spans) {
    out += `${text.slice(from, start)}${marker}`;
    from = end;
  }
  return out + text.slice(from);
}

/**
 * `text` with the union of every occurrence of each value (secretSpans) replaced by the marker;
 * values shorter than the minimum length are left alone.
 */
export function redactExactSecretValues(text: string, values: Iterable<string>, options: RedactOptions = {}): string {
  return maskSpans(text, secretSpans(text, values, options.minLength), options.marker);
}

/**
 * Whether `text` equals, contains, or is contained in any of `values`, under the same minimum
 * length as redactExactSecretValues. For a short field that is sent whole or not at all (a native
 * gateway error's cause code), where redacting part of it would still leave part of a value.
 */
export function overlapsSecretValue(text: string, values: Iterable<string>): boolean {
  for (const value of values) {
    if (value.length < MIN_REDACTABLE_SECRET_LENGTH) continue;
    if (text.includes(value) || value.includes(text)) return true;
  }
  return false;
}
