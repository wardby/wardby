/**
 * Turns a tool call or a model message into the text a step's summary is cut from, and cuts it.
 * Redaction runs on the control plane (stepSummarizer), on the raw step text, before anything is
 * stored, for native and coding runs alike: whitespace is collapsed, then one pass of the shared
 * redactor masks every form of every secret value together (secretForms) and any secret start the
 * text ends in, then token shapes. The summary is cut only after redaction, so a cut never
 * splits a secret and leaves half of it visible.
 */
import { REDACTED, redactSecrets } from "../../coding/redact.js";
import { CLAUDE_MCP_TOOL_PREFIX, WORKER_MCP_SERVER_KEY } from "../../coding/mcp-token.js";
import { MIN_REDACTABLE_SECRET_LENGTH, withEscapedForms } from "../secret-spans.js";
import {
  MAX_STEP_TEXT_CHARS,
  SAID_SUMMARY_CHARS,
  STEP_TOOL_NAME,
  TOOL_SUMMARY_CHARS,
  type ExtractedStep,
} from "./types.js";

/** Claude Code's one shell tool through the coding proxy (src/providers/coding-proxy/proxy.ts). */
export const CLAUDE_COMMAND_TOOL = "mcp__wardby_tools__run_command";
/** The namespace Codex gives the worker's MCP tools. */
const CODEX_MCP_NAMESPACE = `mcp__${WORKER_MCP_SERVER_KEY}`;
/** Arguments longer than this are not parsed whole; their leading field is read instead. */
const MAX_PARSE_CHARS = 256 * 1024;

export function bounded(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_STEP_TEXT_CHARS
    ? { text: text.slice(0, MAX_STEP_TEXT_CHARS), truncated: true }
    : { text, truncated: false };
}

/** A tool's name as a step shows it; anything that isn't a plain name becomes "tool". */
export function displayToolName(name: string, namespace?: string): string {
  let shown: string;
  // Claude Code's one shell tool shows as the shell tool it stands for.
  if (name === CLAUDE_COMMAND_TOOL || name === "run_command") shown = "Bash";
  else if (name.startsWith(CLAUDE_MCP_TOOL_PREFIX)) shown = `mcp:${name.slice(CLAUDE_MCP_TOOL_PREFIX.length)}`;
  else if (namespace === CODEX_MCP_NAMESPACE) shown = `mcp:${name}`;
  else if (namespace) shown = `${namespace}.${name}`;
  else shown = name;
  return STEP_TOOL_NAME.test(shown) ? shown : "tool";
}

const SHELLS = new Set(["bash", "sh", "zsh", "/bin/bash", "/bin/sh", "/bin/zsh", "/usr/bin/bash"]);
const COMMAND_TOOLS = new Set(["run_command", "Bash", "shell", "exec_command", "local_shell", "shell_command"]);
const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const CODE_MODE_CMD = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\[[^\]]*\])/;
const LEADING_FIELD = /"(?:command|cmd|file_path|path|pattern)"\s*:\s*"((?:[^"\\]|\\.)*)/;

/** A command given as a string or an argv array; `bash -lc "<script>"` shows the script. */
function commandText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.every((part) => typeof part === "string")) return undefined;
  const argv = value;
  if (argv.length === 3 && SHELLS.has(argv[0]) && (argv[1] === "-lc" || argv[1] === "-c")) return argv[2];
  return argv.join(" ");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A JavaScript string or array literal from Codex code mode, as a value; its inner text if it won't parse. */
function parseLiteral(literal: string): unknown {
  if (literal.startsWith("'")) return literal.slice(1, -1).replace(/\\'/g, "'");
  return parseJson(literal) ?? literal.slice(1, -1);
}

/**
 * A free-form tool input (a patch, Codex code-mode JavaScript, anything else). Otherwise its first
 * non-blank line, `cut` when later lines are dropped: that line may be the start of a secret.
 */
function customInput(tool: string, input: string): { text: string; cut: boolean } {
  if (tool === "apply_patch" || input.startsWith("*** Begin Patch")) {
    const files = [...input.matchAll(PATCH_FILE)].map((match) => match[1].trim());
    if (files.length > 0) return { text: files.join(", "), cut: false };
  }
  const cmd = CODE_MODE_CMD.exec(input);
  if (cmd) {
    const command = commandText(parseLiteral(cmd[1]));
    if (command !== undefined) return { text: command, cut: false };
  }
  const lines = input.split("\n");
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first < 0) return { text: "", cut: false };
  return { text: lines[first].trim(), cut: lines.slice(first + 1).some((line) => line.trim().length > 0) };
}

/** The text a tool step's summary is cut from: the command, the path, the pattern, or the first argument. */
export function toolInputText(tool: string, input: unknown): string {
  return toolInput(tool, input).text;
}

/** toolInputText, and whether part of a free-form input was dropped (customInput). */
function toolInput(tool: string, input: unknown): { text: string; cut: boolean } {
  if (typeof input === "string") return customInput(tool, input);
  if (tool === "apply_patch" && input && typeof input === "object" && !Array.isArray(input)) {
    const patch = (input as Record<string, unknown>).input;
    if (typeof patch === "string") return customInput(tool, patch);
  }
  return { text: plainInputText(tool, input), cut: false };
}

function plainInputText(tool: string, input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const args = input as Record<string, unknown>;
  if (COMMAND_TOOLS.has(tool)) {
    const command = commandText(args.command ?? args.cmd);
    if (command !== undefined) return command;
  }
  if (typeof args.pattern === "string") {
    return typeof args.path === "string" ? `${args.pattern} in ${args.path}` : args.pattern;
  }
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  for (const value of Object.values(args)) {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return "";
}

/**
 * The leading string field of cut-off JSON; `open` when the string never closed (it ran to the end
 * of the input). Only an escape the cut left unfinished is dropped (an unpaired trailing backslash,
 * or a partial `\\u` escape); a field that still won't decode is `undefined` text, never raw escapes.
 */
function leadingStringField(json: string): { text: string | undefined; open: boolean } | undefined {
  const match = LEADING_FIELD.exec(json);
  if (!match) return undefined;
  const open = json[match.index + match[0].length] !== '"';
  const raw = match[1].replace(/(?<!\\)((?:\\\\)*)(?:\\u[0-9a-fA-F]{0,3}|\\)$/, "$1");
  const decoded = parseJson(`"${raw}"`);
  return { text: typeof decoded === "string" ? decoded : undefined, open };
}

/** A tool step's text from its JSON arguments (complete or cut off). */
export function toolStepText(tool: string, argsJson: string): { text: string; truncated: boolean } {
  const parsed = argsJson.length <= MAX_PARSE_CHARS ? parseJson(argsJson) : undefined;
  if (parsed !== undefined) {
    const input = toolInput(tool, parsed);
    const out = bounded(input.text);
    return { text: out.text, truncated: out.truncated || input.cut };
  }
  const leading = leadingStringField(argsJson.slice(0, MAX_STEP_TEXT_CHARS));
  // A field that won't decode could show a secret in escaped form: nothing of it is shown.
  if (leading && leading.text === undefined) return { text: REDACTED, truncated: true };
  const out = bounded(leading?.text ?? "");
  return {
    text: out.text,
    // An unclosed string was cut off by the provider or by us: it may end in the start of a secret.
    truncated: out.truncated || argsJson.length > MAX_STEP_TEXT_CHARS || !!leading?.open,
  };
}

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Every form a secret value can take in a collapsed step text, longest first: each value as
 * written and whitespace-collapsed (the model wrote it with other whitespace), each of those
 * JSON-escaped (withEscapedForms: a value inside JSON text), and each of those collapsed.
 */
export function secretForms(secretValues: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const escaped of withEscapedForms(secretValues.flatMap((value) => [value, collapseWhitespace(value)]))) {
    for (const form of [escaped, collapseWhitespace(escaped)]) if (form) forms.add(form);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/** KMP failure table of `pattern`: entry i is the longest proper border of pattern[0..i]. */
function failureTable(pattern: string): Int32Array {
  const fail = new Int32Array(pattern.length);
  for (let i = 1, k = 0; i < pattern.length; i++) {
    while (k > 0 && pattern.charCodeAt(i) !== pattern.charCodeAt(k)) k = fail[k - 1];
    if (pattern.charCodeAt(i) === pattern.charCodeAt(k)) k++;
    fail[i] = k;
  }
  return fail;
}

/**
 * The longest proper prefix of any form (at least the minimum length) that `text` ends with, or
 * "" if none. Linear in the text per form (a KMP scan), whatever the forms look like. `tables`
 * holds each form's failure table, built the first time a cut text needs it.
 */
function secretTail(text: string, forms: readonly string[], tables: Map<string, Int32Array>): string {
  let best = 0;
  for (const form of forms) {
    // A form's proper prefixes; the text is never longer than the step text bound.
    const pattern = form.length - 1 > MAX_STEP_TEXT_CHARS ? form.slice(0, MAX_STEP_TEXT_CHARS) : form.slice(0, -1);
    if (pattern.length < MIN_REDACTABLE_SECRET_LENGTH || pattern.length <= best) continue;
    let fail = tables.get(form);
    if (!fail) tables.set(form, (fail = failureTable(pattern)));
    let k = 0;
    for (let i = Math.max(0, text.length - pattern.length); i < text.length; i++) {
      if (k === pattern.length) k = fail[k - 1];
      while (k > 0 && text.charCodeAt(i) !== pattern.charCodeAt(k)) k = fail[k - 1];
      if (text.charCodeAt(i) === pattern.charCodeAt(k)) k++;
    }
    if (k >= MIN_REDACTABLE_SECRET_LENGTH && k > best) best = k;
  }
  return best > 0 ? text.slice(text.length - best) : "";
}

/**
 * Summaries for one batch, against every secret value delivered to the run (the agent's and the
 * run's own, such as its capability). The forms are built once per batch. Each step's text (at
 * most 16 KiB) is whitespace collapsed, then redacted once with the shared redactor
 * (redactSecrets: the union of every occurrence of every form, then token shapes), then cut to 100
 * characters (tool) or 120 (said). Any text may end in the start of a secret (it was cut, or a
 * stream stopped early without saying so), so on every step the longest such start (secretTail,
 * on the collapsed text before any masking) is redacted in the same pass as one more exact value,
 * so it merges with any whole secret it overlaps.
 */
export function stepSummarizer(
  secretValues: readonly string[],
): (step: Pick<ExtractedStep, "kind" | "text" | "truncated">) => string {
  const forms = secretForms(secretValues);
  const tables = new Map<string, Int32Array>();
  return (step) => {
    const collapsed = collapseWhitespace(step.text.slice(0, MAX_STEP_TEXT_CHARS));
    // Every step: a text can end mid-secret without being marked cut (a stream that stopped early).
    const tail = secretTail(collapsed, forms, tables);
    const text = redactSecrets(collapsed, tail ? [...forms, tail] : forms);
    const limit = step.kind === "tool" ? TOOL_SUMMARY_CHARS : SAID_SUMMARY_CHARS;
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  };
}

/** One step's stored summary (stepSummarizer, for a single step). */
export function stepSummary(
  step: Pick<ExtractedStep, "kind" | "text" | "truncated">,
  secretValues: readonly string[],
): string {
  return stepSummarizer(secretValues)(step);
}
