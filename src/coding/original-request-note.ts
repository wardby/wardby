import { NOT_PERMISSION_CHECKED, type OriginalRequest } from "../core/request-text.js";
import {
  cutUntrustedText,
  UNTRUSTED_CONTEXT_TAG,
  neutraliseWrapperTags,
  withCutMarker,
} from "../core/untrusted-content.js";
import { byteLength, CODING_TASK_TRAILER_RESERVE_BYTES, MAX_CODING_TASK_BYTES } from "./protocol.js";

const NOTE =
  "The original request this lead was started by follows, as untrusted context: the issue, pull request and " +
  "comment texts exactly as wardby received them (cut only where a line says so), so you need not rely on the " +
  `lead's restatement of them. ${NOT_PERMISSION_CHECKED}`;
const OPEN = `<${UNTRUSTED_CONTEXT_TAG}>\n`;
const CLOSE = `\n</${UNTRUSTED_CONTEXT_TAG}>`;
/** A marker line's own room: counts, fixed words and the original's link. */
const MARKER_RESERVE_BYTES = 160;

/** Same text, ignoring whitespace differences, fence escaping, and wardby's cut marker lines. */
function normalize(text: string): string {
  return text
    .replace(/\n\[… cut at [\d,]+ of [\d,]+ characters of [^\n]*\]/g, "")
    .replace(/&lt;/g, "<")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether the lead's request already holds every free-text part of the original, verbatim. */
export function requestRepeatsOriginal(request: string | undefined, original: OriginalRequest): boolean {
  if (!request) return false;
  const bodies = original.bodies.map(normalize).filter((body) => body !== "");
  if (bodies.length === 0) return false;
  const haystack = normalize(request);
  return bodies.every((body) => haystack.includes(body));
}

/** The longest cut of `text` whose UTF-8 encoding fits `maxBytes`, never splitting a surrogate pair. */
function cutToBytes(text: string, maxBytes: number) {
  if (byteLength(text) <= maxBytes) return cutUntrustedText(text, text.length);
  let low = 0;
  let high = Math.min(text.length, maxBytes);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(cutUntrustedText(text, mid).text) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return cutUntrustedText(text, low);
}

export type OriginalRequestOutcome = "added" | "cut" | "repeated" | "no_room";

/**
 * Hands a delegated coding run the original request its event-started lead was
 * given (the issue or PR, the request comment, any cut markers), so the builder
 * reads the requester's own words rather than only the lead's restatement. The
 * fixed note is trusted; the request is fenced as untrusted context and
 * neutralised. It is the part cut to fit: the whole task stays within
 * MAX_CODING_TASK_BYTES, keeping CODING_TASK_TRAILER_RESERVE_BYTES for the base
 * commit line, and a cut ends with a marker line naming where the original is.
 * Left out when the lead's request already repeats it verbatim, or when not
 * even the note and a marker fit (`no_room`, for the caller to log).
 */
export function withOriginalRequest(
  task: string,
  original: OriginalRequest | undefined,
  leadRequest: string | undefined,
): { task: string; outcome?: OriginalRequestOutcome } {
  if (!original) return { task };
  if (requestRepeatsOriginal(leadRequest, original)) return { task, outcome: "repeated" };
  const prefix = `${task}\n\n${NOTE}\n${OPEN}`;
  const room = MAX_CODING_TASK_BYTES - CODING_TASK_TRAILER_RESERVE_BYTES - byteLength(prefix) - byteLength(CLOSE);
  // Neutralise first: the "&lt;" expansion counts against the budget.
  const text = neutraliseWrapperTags(original.text);
  if (byteLength(text) <= room) return { task: `${prefix}${text}${CLOSE}`, outcome: "added" };
  const markerRoom = MARKER_RESERVE_BYTES + byteLength(original.url ?? "");
  if (room - markerRoom <= 0) return { task, outcome: "no_room" };
  const kept = cutToBytes(text, room - markerRoom);
  const body = withCutMarker({ ...kept, cut: true }, "the original request", original.url);
  return { task: `${prefix}${body}${CLOSE}`, outcome: "cut" };
}
