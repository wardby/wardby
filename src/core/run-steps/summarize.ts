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
 * longer one can't break the longer match. The forms (and their piece index) are kept for the last
 * few values lists by content, so they are built once, not once per step or batch; the list handed
 * out is frozen.
 */
export function secretForms(secretValues: readonly string[]): readonly string[] {
  return formsEntry(secretValues).forms;
}

interface FormsEntry {
  values: readonly string[];
  forms: readonly string[];
  index?: PieceIndex;
}
/** The last few values lists seen, by content: one agent's batches read equal values, as new arrays. */
const recentForms: FormsEntry[] = [];
const RECENT_FORMS = 8;
const sameValues = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

function formsEntry(secretValues: readonly string[]): FormsEntry {
  const hit = recentForms.findIndex((entry) => sameValues(entry.values, secretValues));
  if (hit >= 0) {
    const [entry] = recentForms.splice(hit, 1);
    recentForms.unshift(entry);
    return entry;
  }
  const forms = new Set<string>();
  for (const escaped of withEscapedForms(secretValues.flatMap((value) => [value, collapseWhitespace(value)]))) {
    const masked = redactSecrets(escaped);
    for (const form of [escaped, collapseWhitespace(escaped), masked, collapseWhitespace(masked)]) {
      if (form && form !== REDACTED) forms.add(form);
    }
  }
  // Frozen: the arrays are shared through the cache, so no caller may change them.
  const entry: FormsEntry = {
    values: Object.freeze([...secretValues]),
    forms: Object.freeze([...forms].sort((a, b) => b.length - a.length)),
  };
  recentForms.unshift(entry);
  recentForms.length = Math.min(recentForms.length, RECENT_FORMS);
  return entry;
}

/** More markers than this in one text and the whole summary is masked (maskAroundMarkers). */
export const MAX_MARKERS_CHECKED = 64;
/** Characters compared around markers in one text before the whole summary is masked. */
const MAX_COMPARED_CHARS = 4_000_000;
/** Candidate pieces are looked up by their first (suffixes) or last (prefixes) this many characters. */
const GRAM = MIN_REDACTABLE_SECRET_LENGTH;

/** A hash of the GRAM characters of `text` from `at` (collisions are resolved by comparing). */
function gramHash(text: string, at: number): number {
  let hash = 0;
  for (let i = at; i < at + GRAM; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return hash;
}

/**
 * Pieces of the forms by the hash of a GRAM-character window: a chained hash table in typed arrays,
 * so building it allocates nothing per piece. Entry n is (form[n], at[n]).
 */
class PieceTable {
  private readonly head: Int32Array;
  private readonly next: Int32Array;
  readonly form: Int32Array;
  readonly at: Int32Array;
  private size = 0;
  constructor(capacity: number) {
    let buckets = 16;
    while (buckets < capacity * 2) buckets *= 2;
    this.head = new Int32Array(buckets).fill(-1);
    this.next = new Int32Array(capacity);
    this.form = new Int32Array(capacity);
    this.at = new Int32Array(capacity);
  }
  add(hash: number, form: number, at: number): void {
    const n = this.size++;
    const bucket = hash & (this.head.length - 1);
    this.form[n] = form;
    this.at[n] = at;
    this.next[n] = this.head[bucket];
    this.head[bucket] = n;
  }
  /** The first entry for `hash`'s bucket, then follow `link`; -1 ends. */
  first(hash: number): number {
    return this.head[hash & (this.head.length - 1)];
  }
  link(n: number): number {
    return this.next[n];
  }
}

/**
 * Every proper suffix and proper prefix (GRAM to MAX_TAIL_CHECK characters) of every form: suffixes
 * by their first GRAM characters (at = the suffix's start), prefixes by their last GRAM (at = the
 * prefix's length). Built once per forms list, and only when a text has a marker to check.
 */
interface PieceIndex {
  suffixes: PieceTable;
  prefixes: PieceTable;
}

function pieceIndex(entry: FormsEntry): PieceIndex {
  if (entry.index) return entry.index;
  const { forms } = entry;
  let pieces = 0;
  for (const form of forms) pieces += Math.max(0, Math.min(form.length - 1, MAX_TAIL_CHECK) - GRAM + 1);
  const suffixes = new PieceTable(pieces);
  const prefixes = new PieceTable(pieces);
  forms.forEach((form, f) => {
    const longest = Math.min(form.length - 1, MAX_TAIL_CHECK);
    for (let k = GRAM; k <= longest; k++) {
      const start = form.length - k;
      suffixes.add(gramHash(form, start), f, start);
      prefixes.add(gramHash(form, k - GRAM), f, k);
    }
  });
  entry.index = { suffixes, prefixes };
  return entry.index;
}

/** Whether `text` holds `form.slice(from, to)` at `at`, counting the characters compared. */
interface Work {
  chars: number;
}

function holdsAt(text: string, at: number, form: string, from: number, to: number, work: Work): boolean {
  if (at < 0 || at + (to - from) > text.length) return false;
  for (let i = from; i < to; i++) {
    work.chars++;
    if (text.charCodeAt(at + i - from) !== form.charCodeAt(i)) return false;
  }
  return true;
}

/** The longest proper suffix of any form that `text` holds at `at` (0 if none). */
function suffixAt(text: string, at: number, forms: readonly string[], table: PieceTable, work: Work): number {
  if (at + GRAM > text.length) return 0;
  let best = 0;
  for (let n = table.first(gramHash(text, at)); n >= 0; n = table.link(n)) {
    const form = forms[table.form[n]];
    const start = table.at[n];
    if (form.length - start > best && holdsAt(text, at, form, start, form.length, work)) best = form.length - start;
  }
  return best;
}

/** The longest proper prefix of any form that `text` holds ending at `end` (0 if none). */
function prefixBefore(text: string, end: number, forms: readonly string[], table: PieceTable, work: Work): number {
  if (end < GRAM) return 0;
  let best = 0;
  for (let n = table.first(gramHash(text, end - GRAM)); n >= 0; n = table.link(n)) {
    const k = table.at[n];
    if (k > best && holdsAt(text, end - k, forms[table.form[n]], 0, k, work)) best = k;
  }
  return best;
}

/**
 * `text` with the rest of a secret next to each marker removed: a context-dependent token shape
 * (URL credentials, `Bearer`, an AWS key name, a token prefix glued to a secret) can mask only part
 * of a secret, so no whole form matches what is left. A run right after a marker that is a proper
 * suffix of a form, or right before one that is a proper prefix (at least 6 characters, at most
 * 4096), is dropped (the marker stays). It fails safe: ordinary context next to a marker that
 * happens to equal such a piece of a secret is dropped too. Each marker is looked up in an index of
 * the forms' pieces, so the cost does not grow with the forms' total length; a text with more than
 * MAX_MARKERS_CHECKED markers, or one that needs more than MAX_COMPARED_CHARS compared, becomes
 * just the marker.
 */
export function maskAroundMarkers(text: string, forms: readonly string[]): string {
  return maskAround(text, { values: [], forms });
}

function maskAround(text: string, entry: FormsEntry): string {
  if (!text.includes(REDACTED) || !entry.forms.some((form) => form.length > GRAM)) return text;
  let markers = 0;
  for (let at = text.indexOf(REDACTED); at >= 0; at = text.indexOf(REDACTED, at + REDACTED.length)) {
    if (++markers > MAX_MARKERS_CHECKED) return REDACTED;
  }
  const { forms } = entry;
  const { suffixes, prefixes } = pieceIndex(entry);
  const work: Work = { chars: 0 };
  let out = text;
  for (let at = out.indexOf(REDACTED); at >= 0; at = out.indexOf(REDACTED, at + REDACTED.length)) {
    const after = at + REDACTED.length;
    for (let k = suffixAt(out, after, forms, suffixes, work); k > 0; k = suffixAt(out, after, forms, suffixes, work)) {
      out = out.slice(0, after) + out.slice(after + k);
    }
    for (
      let k = prefixBefore(out, at, forms, prefixes, work);
      k > 0;
      k = prefixBefore(out, at, forms, prefixes, work)
    ) {
      out = out.slice(0, at - k) + out.slice(at);
      at -= k;
    }
    if (work.chars > MAX_COMPARED_CHARS) return REDACTED;
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
  const entry = formsEntry(secretValues);
  const values = entry.forms;
  let text = redactSecrets(collapseWhitespace(step.text.slice(0, MAX_STEP_TEXT_CHARS)), values);
  if (cut) text = maskTruncatedTail(text, values);
  text = maskAround(text, entry);
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
