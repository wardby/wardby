/**
 * The one place untrusted text is fenced for the model. Tool results
 * (engine-native.ts) and a run's untrusted context (the parts of a trigger
 * nobody vetted, e.g. a GitHub issue's title and description) are delivered
 * inside wrapper tags; a run's task is fenced in the system prompt by
 * run_task tags (runner.ts). Every one of those tags is only a boundary if
 * the content inside cannot write it, so all wrapped text passes through
 * neutraliseWrapperTags first (H5-6 / E-09).
 */

export const UNTRUSTED_TOOL_OUTPUT_TAG = "untrusted_tool_output";
export const UNTRUSTED_CONTEXT_TAG = "untrusted_context";
export const RUN_TASK_TAG = "run_task";

/** Invisible characters (zero-width, bidi controls, soft hyphen, variation selectors, tag characters, ...). */
const IGNORABLE = "\\p{Default_Ignorable_Code_Point}";
/** "<" and its common lookalikes: fullwidth, small, angle brackets, single guillemet. */
const BRACKET = "[<\\uFF1C\\uFE64\\u2329\\u3008\\u27E8\\u2039]";
/** Between the bracket and the name: whitespace, invisibles, and any number of slashes, backslashes or slash lookalikes. */
const LEAD = `[\\s${IGNORABLE}/\\\\\\uFF0F\\u2215\\u2044\\u29F8]*`;
/** Between "run" and "task": whitespace, invisibles, "_", "-" and their dash/fullwidth lookalikes. */
const JOIN = `[\\s${IGNORABLE}_\\-\\u2010-\\u2015\\uFF3F\\uFF0D]*`;

/** One ASCII letter or its fullwidth form (the `i` flag covers either case). */
const letter = (ch: string): string => `[${ch}${String.fromCharCode(0xff41 + ch.charCodeAt(0) - 0x61)}]`;
/** A word whose letters may be separated by invisible characters. */
const word = (w: string): string => [...w].map(letter).join(`[${IGNORABLE}]*`);

/**
 * A bracket that could be read as opening or closing one of the fences: a
 * "<" or lookalike, then LEAD, then the start of a fence name ("untrusted…"
 * or "run_task" / "run-task" / "run task"), in any case, with invisible
 * characters or fullwidth letters allowed inside the name. Only the bracket
 * is replaced, with "&lt;", so the rest of the text is unchanged.
 *
 * Linear time (I-1): every starred class is followed by a letter it cannot
 * contain, so it has exactly one way to match, and a failed attempt at one
 * bracket gives back each character at most once. Homoglyphs from other
 * scripts inside the name (a Cyrillic "е") are not caught.
 */
const FENCE_TAG_LIKE = new RegExp(
  `${BRACKET}(?=${LEAD}(?:${word("untrusted")}|${word("run")}${JOIN}${word("task")}))`,
  "giu",
);

/** Makes every fence-like tag in `content` inert. Idempotent. */
export function neutraliseWrapperTags(content: string): string {
  return content.replace(FENCE_TAG_LIKE, "&lt;");
}

/** `content` between `<tag>` and `</tag>`, unable to close or reopen either fence itself. */
export function wrapUntrusted(tag: string, content: string): string {
  return `<${tag}>\n${neutraliseWrapperTags(content)}\n</${tag}>`;
}

const CONTEXT_OPEN = `<${UNTRUSTED_CONTEXT_TAG}>\n`;
const CONTEXT_CLOSE = `\n</${UNTRUSTED_CONTEXT_TAG}>`;

/**
 * Stores a run's task and its untrusted context in the one Run.taskOverride
 * column: the task, then a wrapped context block. Both parts are
 * neutralised, so the stored text holds exactly one real context opener.
 */
export function composeTaskOverride(task: string, untrustedContext?: string): string {
  const safeTask = neutraliseWrapperTags(task);
  return untrustedContext ? `${safeTask}\n\n${wrapUntrusted(UNTRUSTED_CONTEXT_TAG, untrustedContext)}` : safeTask;
}

/**
 * The inverse of composeTaskOverride, read by the runner. Everything from the
 * first context opener on is context. A producer that wrote the opener
 * without composeTaskOverride (a webhook caller, a delegating model) can only
 * demote its own text into the untrusted context, never promote any.
 */
export function splitTaskOverride(taskOverride: string): { task: string; untrustedContext?: string } {
  const at = taskOverride.startsWith(CONTEXT_OPEN) ? 0 : taskOverride.indexOf(`\n${CONTEXT_OPEN}`);
  if (at < 0) return { task: taskOverride };
  const task = taskOverride.slice(0, at).trimEnd();
  let rest = taskOverride.slice(at === 0 ? CONTEXT_OPEN.length : at + 1 + CONTEXT_OPEN.length);
  if (rest.endsWith(CONTEXT_CLOSE)) rest = rest.slice(0, -CONTEXT_CLOSE.length);
  return { task, untrustedContext: rest };
}
