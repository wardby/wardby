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

/**
 * A "<" (or a common Unicode lookalike: fullwidth, small, angle brackets,
 * single guillemet), then optional whitespace, invisible characters, and a
 * "/", then the start of any of our tag names — i.e. anything that could be
 * read as opening or closing one of the fences, in any case. Only the
 * bracket is replaced, with "&lt;", so the rest of the text is unchanged.
 */
const FENCE_TAG_LIKE =
  /[<\uFF1C\uFE64\u2329\u3008\u27E8\u2039][\s\u200B-\u200D\u2060\uFEFF]*(\/?[\s\u200B-\u200D\u2060\uFEFF]*(?:untrusted|run_task))/giu;

/** Makes every fence-like tag in `content` inert. Idempotent. */
export function neutraliseWrapperTags(content: string): string {
  return content.replace(FENCE_TAG_LIKE, "&lt;$1");
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
