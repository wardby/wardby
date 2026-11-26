import { codingOutputJsonSchema } from "../coding-worker/output-schema.js";

/**
 * Schema keywords Gemini's structured output refuses for wardby's final answer. `maxItems: 64`
 * answers 400 "The specified schema produces a constraint that has too many states for serving"
 * (risk spike, risk 1). wardby validates the answer with its own schema afterwards
 * (run-frame.ts parseAgentOutput), which enforces every dropped limit (output.test.ts).
 */
export const GEMINI_DROPPED_SCHEMA_KEYWORDS: readonly string[] = ["maxItems"];

type Schema = Record<string, unknown>;

/** Drops the keywords from a schema node, then from its sub-schemas; property names are never touched. */
function strip(node: unknown): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const out: Schema = {};
  for (const [key, value] of Object.entries(node as Schema)) {
    if (GEMINI_DROPPED_SCHEMA_KEYWORDS.includes(key)) continue;
    if (key === "properties") {
      out.properties = Object.fromEntries(Object.entries(value as Schema).map(([name, inner]) => [name, strip(inner)]));
    } else if (key === "items") {
      out.items = strip(value);
    } else if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      out[key] = (value as unknown[]).map(strip);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** wardby's final-answer schema (single- or multi-repo) in the form Gemini serves. */
export function geminiOutputJsonSchema(multi: boolean): Schema {
  return strip(codingOutputJsonSchema(multi)) as Schema;
}

/**
 * Escapes every "@" no backslash already precedes. 0.70.0 runs each non-interactive prompt through
 * its @-reference handling with no setting to turn it off: an "@" not preceded by a backslash, then
 * a path, inlines that file (or names an agent, or reads an MCP resource) into the prompt — e-mail
 * addresses included. With no reference found it sends the text unchanged, backslashes kept, so the
 * model reads a literal "\@". The agent can still read any file with its tools; this keeps file contents
 * out of the prompt wardby writes (spec: never `@path` includes).
 */
export function escapeGeminiAtReferences(text: string): string {
  return text.replace(/(?<!\\)@/g, "\\@");
}

/**
 * Appended after escaping, to both prompts: tells the model what the escape means. Its only at sign
 * is the escaped one (an unescaped "@" followed by a path or a quote would be read as a reference).
 */
export const GEMINI_AT_ESCAPE_NOTE =
  "Note: every at sign in this prompt is written as \\@ (with a backslash before it) only so the CLI does not read it as a file reference. Read each one as a plain at sign, and never type that backslash in your own replies, files, commits or commands.";

/**
 * The prompt the CLI gets: the security instructions, the task (boundedTaskPrompt, with its runId
 * line), and the answer's shape. The schema is also set on the run model's replies
 * (settings.ts customOverrides); the prompt says it too (prompt-only was 3/3 in the spike).
 */
export function geminiTaskPrompt(input: { instructions: string; task: string; schema: Schema }): string {
  const prompt = `${input.instructions}\n\n${input.task}\n\nWhen you have finished, your final reply must be only one JSON object (no prose, no code fences) that follows this JSON Schema:\n${JSON.stringify(input.schema)}`;
  // A prompt starting with "/" would run a repository's custom command (.gemini/commands).
  return `${escapeGeminiAtReferences(prompt.startsWith("/") ? ` ${prompt}` : prompt)}\n\n${GEMINI_AT_ESCAPE_NOTE}`;
}

/** The one repair turn after a missing or invalid final answer (run with --resume latest). */
export function geminiRepairPrompt(runId: string): string {
  const repair = escapeGeminiAtReferences(
    `Your last reply was not the JSON object this task requires. Do not call any tools and do not change any files. Reply with only one JSON object that follows the JSON Schema given earlier, with runId ${runId}.`,
  );
  return `${repair}\n\n${GEMINI_AT_ESCAPE_NOTE}`;
}
