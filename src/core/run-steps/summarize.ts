/**
 * Turns a tool call or a model message into the text a step's summary is cut from, and cuts it.
 * Redaction runs on the control plane (stepSummary), before anything is stored: whitespace is
 * collapsed first, then one pass masks every form of every secret value together (as written,
 * JSON-escaped, collapsed, token-masked: secretForms), then token shapes (redactSecrets), then any
 * piece of a secret left next to a marker (maskAroundMarkers). The summary is cut only after redaction, so a cut never splits a secret and
 * leaves half of it visible; a text an extractor already cut is checked for a secret's start at
 * its end (maskTruncatedTail).
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
  type RunStepBatch,
} from "./types.js";

/** Claude Code's one shell tool through the coding proxy (src/providers/coding-proxy/proxy.ts). */
export const CLAUDE_COMMAND_TOOL = "mcp__wardby_tools__run_command";
/** The namespace Codex gives the worker's MCP tools. */
const CODEX_MCP_NAMESPACE = `mcp__${WORKER_MCP_SERVER_KEY}`;
/** Arguments longer than this are not parsed whole; their leading field is read instead. */
const MAX_PARSE_CHARS = 256 * 1024;
/** The longest secret prefix maskTruncatedTail looks for. */
const MAX_TAIL_CHECK = 4096;

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

/** A free-form tool input (a patch, Codex code-mode JavaScript, anything else). */
function customInputText(tool: string, input: string): string {
  if (tool === "apply_patch" || input.startsWith("*** Begin Patch")) {
    const files = [...input.matchAll(PATCH_FILE)].map((match) => match[1].trim());
    if (files.length > 0) return files.join(", ");
  }
  const cmd = CODE_MODE_CMD.exec(input);
  if (cmd) {
    const command = commandText(parseLiteral(cmd[1]));
    if (command !== undefined) return command;
  }
  return (
    input
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

/** The text a tool step's summary is cut from: the command, the path, the pattern, or the first argument. */
export function toolInputText(tool: string, input: unknown): string {
  if (typeof input === "string") return customInputText(tool, input);
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const args = input as Record<string, unknown>;
  if (COMMAND_TOOLS.has(tool)) {
    const command = commandText(args.command ?? args.cmd);
    if (command !== undefined) return command;
  }
  if (tool === "apply_patch" && typeof args.input === "string") return customInputText(tool, args.input);
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

/** The leading string field of cut-off JSON; `open` when the string never closed (it ran to the end of the input). */
function leadingStringField(json: string): { text: string; open: boolean } | undefined {
  const match = LEADING_FIELD.exec(json);
  if (!match) return undefined;
  const open = json[match.index + match[0].length] !== '"';
  const raw = match[1].replace(/\\$/, "");
  const decoded = parseJson(`"${raw}"`);
  return { text: typeof decoded === "string" ? decoded : raw, open };
}

/** A tool step's text from its JSON arguments (complete or cut off). */
export function toolStepText(tool: string, argsJson: string): { text: string; truncated: boolean } {
  const parsed = argsJson.length <= MAX_PARSE_CHARS ? parseJson(argsJson) : undefined;
  const leading = parsed === undefined ? leadingStringField(argsJson.slice(0, MAX_STEP_TEXT_CHARS)) : undefined;
  const out = bounded(parsed !== undefined ? toolInputText(tool, parsed) : (leading?.text ?? ""));
  return {
    text: out.text,
    // An unclosed string was cut off by the provider or by us: it may end in the start of a secret.
    truncated: out.truncated || (parsed === undefined && (argsJson.length > MAX_STEP_TEXT_CHARS || !!leading?.open)),
  };
}

/** `text` with a trailing start of any secret value (at least the minimum length) masked. */
export function maskTruncatedTail(text: string, secretValues: readonly string[]): string {
  let best = 0;
  for (const value of secretValues) {
    const longest = Math.min(value.length - 1, text.length, MAX_TAIL_CHECK);
    for (let k = longest; k > best && k >= MIN_REDACTABLE_SECRET_LENGTH; k--) {
      if (text.endsWith(value.slice(0, k))) {
        best = k;
        break;
      }
    }
  }
  return best > 0 ? `${text.slice(0, text.length - best)}${REDACTED}` : text;
}

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Every form a secret value can take in a collapsed step text, longest first: the value and its
 * JSON-escaped forms (withEscapedForms: a value inside JSON text), each as written,
 * whitespace-collapsed (the model wrote it with other whitespace), token-masked (the coding proxy
 * masked a token-shaped word inside it before sending, maskForTransport), and token-masked and
 * collapsed. Matching them all in one pass means a shorter secret, or a token-shaped word, inside a
 * longer one can't break the longer match. One batch's steps share one values array, so the forms
 * are computed once per array.
 */
export function secretForms(secretValues: readonly string[]): string[] {
  const cached = formsCache.get(secretValues);
  // The copy guards against an array changed after it was cached.
  if (cached && sameValues(cached.values, secretValues)) return cached.forms;
  const forms = new Set<string>();
  for (const escaped of withEscapedForms(secretValues.flatMap((value) => [value, collapseWhitespace(value)]))) {
    const masked = redactSecrets(escaped);
    for (const form of [escaped, collapseWhitespace(escaped), masked, collapseWhitespace(masked)]) {
      if (form && form !== REDACTED) forms.add(form);
    }
  }
  const out = [...forms].sort((a, b) => b.length - a.length);
  formsCache.set(secretValues, { values: [...secretValues], forms: out });
  return out;
}
const formsCache = new WeakMap<readonly string[], { values: string[]; forms: string[] }>();
const sameValues = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** Whether `text` holds `form.slice(from, to)` at `at`. */
function holdsAt(text: string, at: number, form: string, from: number, to: number): boolean {
  if (at < 0 || at + (to - from) > text.length) return false;
  for (let i = from; i < to; i++) if (text.charCodeAt(at + i - from) !== form.charCodeAt(i)) return false;
  return true;
}

/** The longest proper suffix (at least the minimum length) of any form that `text` holds at `at`. */
function suffixAt(text: string, at: number, forms: readonly string[]): number {
  let best = 0;
  if (at >= text.length) return 0;
  const first = text[at];
  for (const form of forms) {
    // A suffix starting at form[i]: the first i is the longest.
    for (let i = form.indexOf(first, 1); i >= 0; i = form.indexOf(first, i + 1)) {
      const k = form.length - i;
      if (k <= best || k < MIN_REDACTABLE_SECRET_LENGTH) break;
      if (k > MAX_TAIL_CHECK) continue;
      if (holdsAt(text, at, form, i, form.length)) {
        best = k;
        break;
      }
    }
  }
  return best;
}

/** The longest proper prefix (at least the minimum length) of any form that `text` holds ending at `end`. */
function prefixBefore(text: string, end: number, forms: readonly string[]): number {
  let best = 0;
  if (end <= 0) return 0;
  const last = text[end - 1];
  for (const form of forms) {
    // A prefix ending at form[j]: the last j is the longest.
    for (let j = form.lastIndexOf(last, form.length - 2); j >= 0; j = j > 0 ? form.lastIndexOf(last, j - 1) : -1) {
      const k = j + 1;
      if (k <= best || k < MIN_REDACTABLE_SECRET_LENGTH) break;
      if (k > MAX_TAIL_CHECK) continue;
      if (holdsAt(text, end - k, form, 0, k)) {
        best = k;
        break;
      }
    }
  }
  return best;
}

/**
 * `text` with the rest of a secret next to each marker removed: a context-dependent token shape
 * (URL credentials, `Bearer`, an AWS key name, a token prefix glued to a secret) can mask only part
 * of a secret, so no whole form matches what is left. A run right after a marker that is a proper
 * suffix of a form, or right before one that is a proper prefix, is dropped (the marker stays).
 */
export function maskAroundMarkers(text: string, forms: readonly string[]): string {
  let out = text;
  for (let at = out.indexOf(REDACTED); at >= 0; at = out.indexOf(REDACTED, at + REDACTED.length)) {
    for (let k = suffixAt(out, at + REDACTED.length, forms); k > 0; k = suffixAt(out, at + REDACTED.length, forms)) {
      out = out.slice(0, at + REDACTED.length) + out.slice(at + REDACTED.length + k);
    }
    for (let k = prefixBefore(out, at, forms); k > 0; k = prefixBefore(out, at, forms)) {
      out = out.slice(0, at - k) + out.slice(at);
      at -= k;
    }
  }
  return out;
}

/**
 * The stored summary: whitespace collapsed, then redacted once against every form of every secret
 * value together (secretForms) and by token shape, then a cut-off text's tail checked against
 * those forms, then any piece of a secret left next to a marker removed (maskAroundMarkers), then
 * cut to 100 characters (tool) or 120 (said).
 */
export function stepSummary(
  step: Pick<ExtractedStep, "kind" | "text" | "truncated">,
  secretValues: readonly string[],
): string {
  const cut = step.truncated || step.text.length > MAX_STEP_TEXT_CHARS;
  const values = secretForms(secretValues);
  let text = redactSecrets(collapseWhitespace(step.text.slice(0, MAX_STEP_TEXT_CHARS)), values);
  if (cut) text = maskTruncatedTail(text, values);
  text = maskAroundMarkers(text, values);
  const limit = step.kind === "tool" ? TOOL_SUMMARY_CHARS : SAID_SUMMARY_CHARS;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * What the coding proxy sends: token shapes masked (it holds no secret values). The control plane
 * redacts by exact value before it writes (RunStepWriter).
 */
export function maskForTransport(batch: RunStepBatch): RunStepBatch {
  return {
    steps: batch.steps.map((step) => {
      const masked = redactSecrets(step.text);
      return {
        ...step,
        text: masked.slice(0, MAX_STEP_TEXT_CHARS),
        // Token masking can lengthen a text, so the cut is judged on the masked text too.
        truncated: step.truncated || step.text.length > MAX_STEP_TEXT_CHARS || masked.length > MAX_STEP_TEXT_CHARS,
      };
    }),
    results: batch.results,
  };
}
