/**
 * Turns a tool call or a model message into the text a step's summary is cut from, and cuts it.
 * Redaction runs on the control plane (stepSummary), before anything is stored: whitespace is
 * collapsed first, then one pass masks every form of every secret value together (as written,
 * JSON-escaped, collapsed, token-masked: secretForms), then token shapes (redactSecrets), then any
 * piece of a secret left next to a marker (maskAroundMarkers). The summary is cut only after redaction, so a cut never splits a secret and
 * leaves half of it visible. A text that arrived cut first loses its last (longest form + 64)
 * characters, where any piece of a secret crossing the cut must lie (stepSummarizer); its end is
 * still checked for a secret's start (maskTruncatedTail) as defence in depth.
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
 * longer one can't break the longer match. The list handed out is frozen (it may be cached).
 */
export function secretForms(secretValues: readonly string[]): readonly string[] {
  return cachedForms(secretValues).forms;
}

function buildForms(secretValues: readonly string[]): readonly string[] {
  const forms = new Set<string>();
  for (const escaped of withEscapedForms(secretValues.flatMap((value) => [value, collapseWhitespace(value)]))) {
    const masked = redactSecrets(escaped);
    for (const form of [escaped, collapseWhitespace(escaped), masked, collapseWhitespace(masked)]) {
      if (form && form !== REDACTED) forms.add(form);
    }
  }
  return Object.freeze([...forms].sort((a, b) => b.length - a.length));
}

/** More markers than this in one text and the whole summary is masked (maskAroundMarkers). */
export const MAX_MARKERS_CHECKED = 64;
/** Index entries walked plus characters compared around markers in one text before the whole summary is masked. */
const MAX_MARKER_WORK = 4_000_000;
/** Candidate pieces are looked up by their first (suffixes) or last (prefixes) this many characters. */
const GRAM = MIN_REDACTABLE_SECRET_LENGTH;
/** The most bytes of forms and piece indexes kept across cached values lists; a bigger list is built per batch, not kept. */
const MAX_CACHED_BYTES = 8 * 1024 * 1024;
/** The most values lists kept. */
const MAX_CACHED_LISTS = 8;

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
    while (buckets < capacity) buckets *= 2;
    this.head = new Int32Array(buckets).fill(-1);
    this.next = new Int32Array(capacity);
    this.form = new Int32Array(capacity);
    this.at = new Int32Array(capacity);
  }
  get bytes(): number {
    return this.head.byteLength + this.next.byteLength + this.form.byteLength + this.at.byteLength;
  }
  add(hash: number, form: number, at: number): void {
    const n = this.size++;
    const bucket = hash & (this.head.length - 1);
    this.form[n] = form;
    this.at[n] = at;
    this.next[n] = this.head[bucket];
    this.head[bucket] = n;
  }
  /** The first entry in `hash`'s bucket (-1: none); follow with link. */
  first(hash: number): number {
    return this.head[hash & (this.head.length - 1)];
  }
  link(n: number): number {
    return this.next[n];
  }
}

/**
 * One values list's forms and, built only when a text has a marker to check, the index of every
 * proper suffix and proper prefix (GRAM to MAX_TAIL_CHECK characters) of every form: suffixes by
 * their first GRAM characters (at = the suffix's start), prefixes by their last GRAM (at = the
 * prefix's length).
 */
class FormSet {
  private index?: { suffixes: PieceTable; prefixes: PieceTable };
  constructor(readonly forms: readonly string[]) {}
  get checksPieces(): boolean {
    return this.forms.some((form) => form.length > GRAM);
  }
  get bytes(): number {
    let bytes = 0;
    for (const form of this.forms) bytes += form.length * 2;
    return bytes + (this.index ? this.index.suffixes.bytes + this.index.prefixes.bytes : 0);
  }
  pieces(): { suffixes: PieceTable; prefixes: PieceTable } {
    if (this.index) return this.index;
    const { forms } = this;
    let count = 0;
    for (const form of forms) count += Math.max(0, Math.min(form.length - 1, MAX_TAIL_CHECK) - GRAM + 1);
    const suffixes = new PieceTable(count);
    const prefixes = new PieceTable(count);
    forms.forEach((form, f) => {
      const longest = Math.min(form.length - 1, MAX_TAIL_CHECK);
      for (let k = GRAM; k <= longest; k++) {
        const start = form.length - k;
        suffixes.add(gramHash(form, start), f, start);
        prefixes.add(gramHash(form, k - GRAM), f, k);
      }
    });
    this.index = { suffixes, prefixes };
    stats.indexBuilds++;
    trimCache();
    return this.index;
  }
}

/**
 * The last few values lists' form sets, by content: one agent's batches read equal values as new
 * arrays. Bounded by count and by bytes (forms plus indexes); a set that alone exceeds the byte
 * bound is used for its batch and not kept.
 */
const cache: Array<{ values: readonly string[]; set: FormSet }> = [];
const sameValues = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

function cachedForms(secretValues: readonly string[]): FormSet {
  const hit = cache.findIndex((entry) => sameValues(entry.values, secretValues));
  if (hit >= 0) {
    const [entry] = cache.splice(hit, 1);
    cache.unshift(entry);
    return entry.set;
  }
  const set = new FormSet(buildForms(secretValues));
  stats.formBuilds++;
  cache.unshift({ values: Object.freeze([...secretValues]), set });
  trimCache();
  return set;
}

/** Drops any set over the byte bound alone, then the least recently used until within both bounds. */
function trimCache(): void {
  for (let i = cache.length - 1; i >= 0; i--) if (cache[i].set.bytes > MAX_CACHED_BYTES) cache.splice(i, 1);
  let bytes = cache.reduce((sum, entry) => sum + entry.set.bytes, 0);
  while (cache.length > MAX_CACHED_LISTS || (cache.length > 0 && bytes > MAX_CACHED_BYTES)) {
    const dropped = cache.pop();
    if (dropped) bytes -= dropped.set.bytes;
  }
}

/** Counters for tests: builds, cached lists and bytes, and how often the marker check gave up. */
const stats = { formBuilds: 0, indexBuilds: 0, markerCapStops: 0, workStops: 0, work: 0 };
export function summaryCacheStats(): typeof stats & { lists: number; bytes: number } {
  return { ...stats, lists: cache.length, bytes: cache.reduce((sum, entry) => sum + entry.set.bytes, 0) };
}

class WorkExceeded extends Error {}
interface Work {
  done: number;
}
const spend = (work: Work, amount: number): void => {
  work.done += amount;
  if (work.done > MAX_MARKER_WORK) throw new WorkExceeded();
};

/** Whether `text` holds `form.slice(from, to)` at `at`. */
function holdsAt(text: string, at: number, form: string, from: number, to: number, work: Work): boolean {
  if (at < 0 || at + (to - from) > text.length) return false;
  let i = from;
  while (i < to && text.charCodeAt(at + i - from) === form.charCodeAt(i)) i++;
  spend(work, i - from + 1);
  return i === to;
}

/** The longest proper suffix of any form that `text` holds at `at` (0 if none). */
function suffixAt(text: string, at: number, sets: readonly FormSet[], work: Work): number {
  if (at + GRAM > text.length) return 0;
  const hash = gramHash(text, at);
  let best = 0;
  for (const set of sets) {
    const { suffixes } = set.pieces();
    for (let n = suffixes.first(hash); n >= 0; n = suffixes.link(n)) {
      spend(work, 1);
      const form = set.forms[suffixes.form[n]];
      const start = suffixes.at[n];
      if (form.length - start > best && holdsAt(text, at, form, start, form.length, work)) best = form.length - start;
    }
  }
  return best;
}

/** The longest proper prefix of any form that `text` holds ending at `end` (0 if none). */
function prefixBefore(text: string, end: number, sets: readonly FormSet[], work: Work): number {
  if (end < GRAM) return 0;
  const hash = gramHash(text, end - GRAM);
  let best = 0;
  for (const set of sets) {
    const { prefixes } = set.pieces();
    for (let n = prefixes.first(hash); n >= 0; n = prefixes.link(n)) {
      spend(work, 1);
      const k = prefixes.at[n];
      if (k > best && holdsAt(text, end - k, set.forms[prefixes.form[n]], 0, k, work)) best = k;
    }
  }
  return best;
}

/**
 * Whether `text` from `at` to its end is a piece (GRAM or more characters, after a form's first
 * character) of any form. Starts in the suffix index are found there; a form too long for the index
 * to cover every start is searched whole, its length spent from the work budget.
 */
function pieceToEnd(text: string, at: number, sets: readonly FormSet[], work: Work): boolean {
  const length = text.length - at;
  if (length < GRAM) return false;
  const hash = gramHash(text, at);
  for (const set of sets) {
    const { suffixes } = set.pieces();
    for (let n = suffixes.first(hash); n >= 0; n = suffixes.link(n)) {
      spend(work, 1);
      const form = set.forms[suffixes.form[n]];
      const start = suffixes.at[n];
      if (start + length <= form.length && holdsAt(text, at, form, start, start + length, work)) return true;
    }
    for (const form of set.forms) {
      if (form.length <= MAX_TAIL_CHECK + 1) continue;
      spend(work, form.length);
      if (form.includes(text.slice(at))) return true;
    }
  }
  return false;
}

/**
 * `text` with the rest of a secret next to each marker removed: a context-dependent token shape
 * (URL credentials, `Bearer`, an AWS key name, a token prefix glued to a secret) can mask only part
 * of a secret, so no whole form matches what is left. A run right after a marker that is a proper
 * suffix of a form, or right before one that is a proper prefix (at least 6 characters, at most
 * 4096), is dropped (the marker stays). It fails safe: ordinary context next to a marker that
 * happens to equal such a piece of a secret is dropped too. Each marker is looked up in an index of
 * the forms' pieces, so the cost does not grow with the forms' total length; a text with more than
 * MAX_MARKERS_CHECKED markers, or one whose check walks or compares more than MAX_MARKER_WORK,
 * becomes just the marker. In a text that was cut (`cut`), a run from the last marker to the end
 * that is any piece of a form is dropped too: a token shape took the secret's head and the cut its
 * tail, so what is left is neither a suffix nor a prefix.
 */
export function maskAroundMarkers(text: string, forms: readonly string[], cut = false): string {
  return maskAround(text, [new FormSet(forms)], cut);
}

function maskAround(text: string, allSets: readonly FormSet[], cut: boolean): string {
  const sets = allSets.filter((set) => set.checksPieces);
  if (!text.includes(REDACTED) || sets.length === 0) return text;
  let markers = 0;
  for (let at = text.indexOf(REDACTED); at >= 0; at = text.indexOf(REDACTED, at + REDACTED.length)) {
    if (++markers > MAX_MARKERS_CHECKED) {
      stats.markerCapStops++;
      return REDACTED;
    }
  }
  const work: Work = { done: 0 };
  try {
    let out = text;
    for (let at = out.indexOf(REDACTED); at >= 0; at = out.indexOf(REDACTED, at + REDACTED.length)) {
      const after = at + REDACTED.length;
      for (let k = suffixAt(out, after, sets, work); k > 0; k = suffixAt(out, after, sets, work)) {
        out = out.slice(0, after) + out.slice(after + k);
      }
      for (let k = prefixBefore(out, at, sets, work); k > 0; k = prefixBefore(out, at, sets, work)) {
        out = out.slice(0, at - k) + out.slice(at);
        at -= k;
      }
    }
    const last = out.lastIndexOf(REDACTED) + REDACTED.length;
    if (cut && pieceToEnd(out, last, sets, work)) out = out.slice(0, last);
    return out;
  } catch (error) {
    if (!(error instanceof WorkExceeded)) throw error;
    stats.workStops++;
    return REDACTED;
  } finally {
    stats.work += work.done;
  }
}

/**
 * Characters dropped from the end of a cut text beyond the longest form: room for the markers a
 * token shape or the proxy's masking left in place of part of a secret.
 */
const CUT_TAIL_SLACK = 64;

/**
 * Summaries for one batch: `secretValues` (the agent's own, cached across batches by content) and
 * `extraValues` (per run, such as a run's gateway capability: never cached, so each run doesn't
 * make a cache entry). Each summary is whitespace collapsed, then redacted once against every form
 * of every value together (secretForms) and by token shape, then a cut-off text's tail checked
 * against those forms, then any piece of a secret left next to a marker (or, in a cut-off text,
 * after the last marker) removed (maskAroundMarkers), then cut to 100 characters (tool) or 120 (said).
 *
 * A text that arrives cut (`truncated`, or over the step text bound) first loses its last L + 64
 * characters, L being the length of the longest form of any value (own or extra; 0 if there are
 * none), before anything else runs. Masking only ever shortens a text, so any piece of a secret
 * that crosses the cut lies in that tail, wherever token shapes split it into pieces between
 * markers. A cut text the drop leaves blank is summarised as just the marker. The passes after it
 * (tail check, pieces next to and after markers) stay as defence in depth.
 */
export function stepSummarizer(
  secretValues: readonly string[],
  extraValues: readonly string[] = [],
): (step: Pick<ExtractedStep, "kind" | "text" | "truncated">) => string {
  const own = cachedForms(secretValues);
  const sets = extraValues.length > 0 ? [own, new FormSet(buildForms(extraValues))] : [own];
  const values = sets.length > 1 ? [...own.forms, ...sets[1].forms] : own.forms;
  // Forms are sorted longest first, so the first of each set is the longest.
  const drop = Math.max(0, ...sets.map((set) => set.forms[0]?.length ?? 0)) + CUT_TAIL_SLACK;
  return (step) => {
    const cut = step.truncated || step.text.length > MAX_STEP_TEXT_CHARS;
    let received = step.text.slice(0, MAX_STEP_TEXT_CHARS);
    if (cut) {
      received = received.slice(0, Math.max(0, received.length - drop));
      if (!received.trim()) return step.text ? REDACTED : "";
    }
    let text = redactSecrets(collapseWhitespace(received), values);
    if (cut) text = maskTruncatedTail(text, values);
    text = maskAround(text, sets, cut);
    const limit = step.kind === "tool" ? TOOL_SUMMARY_CHARS : SAID_SUMMARY_CHARS;
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  };
}

/** One step's stored summary (stepSummarizer, for a single step). */
export function stepSummary(
  step: Pick<ExtractedStep, "kind" | "text" | "truncated">,
  secretValues: readonly string[],
  extraValues: readonly string[] = [],
): string {
  return stepSummarizer(secretValues, extraValues)(step);
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
