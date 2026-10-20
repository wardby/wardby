/**
 * PyPI dependency lines (PEP 508 requirements as wheel METADATA and PyPI's
 * `requires_dist` write them) and the extras policy both the graph walk and
 * lockfile verification follow. Kept free of imports from pypi.ts, which
 * imports this module.
 */
import type { FileDependency } from "./types.js";

/** The most extras one allowlist entry or dependency line may name. */
export const MAX_EXTRAS = 32;

/** A valid PyPI project name (PEP 508): ASCII letters and digits, with
 *  `.`, `_` and `-` allowed only between them. */
const PROJECT_NAME = /^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])$/;

export function isPypiProjectName(name: string): boolean {
  return PROJECT_NAME.test(name);
}

export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Normalized (PEP 685), sorted, de-duplicated extras from the text inside
 *  `[...]`, or null when any is not a valid extra name (PEP 508: the same
 *  shape as a project name), the list is empty, or it names too many. */
export function parseExtras(list: string): string[] | null {
  const items = list.split(",").map((item) => item.trim());
  if (items.length > MAX_EXTRAS || items.some((item) => !PROJECT_NAME.test(item))) return null;
  return [...new Set(items.map(normalizePypiName))].sort();
}

/** The string literals a marker compares `extra` to with `==` or `===`
 *  (either operand order), normalized; null when the marker never mentions
 *  `extra`. Tokenized, so a quoted value never counts as a clause. Fails
 *  closed: when `extra` appears in any shape this does not fully recognise
 *  (`extra in "a b"`, `extra.x`, a bare `extra`, an unbalanced quote), the
 *  line is gated on no extra at all, so it is never followed. */
function markerExtras(marker: string): string[] | null {
  if (!/\bextra\b/.test(marker)) return null;
  const tokens = marker.match(/"[^"]*"|'[^']*'|===|==|!=|<=|>=|~=|[A-Za-z_][A-Za-z0-9_.]*|\S/g) ?? [];
  const isLiteral = (token: string | undefined) =>
    token !== undefined && token.length >= 2 && (token[0] === '"' || token[0] === "'");
  const isEquals = (token: string | undefined) => token === "==" || token === "===";
  // A lone quote (unterminated string) means the marker cannot be read.
  if (tokens.some((token) => token === '"' || token === "'")) return [];
  const found: string[] = [];
  let recognised = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "extra") continue;
    let value: string | null = null;
    if (isEquals(tokens[i + 1]) && isLiteral(tokens[i + 2])) value = tokens[i + 2].slice(1, -1);
    else if (isEquals(tokens[i - 1]) && isLiteral(tokens[i - 2])) value = tokens[i - 2].slice(1, -1);
    if (value === null) return [];
    recognised++;
    if (PROJECT_NAME.test(value)) found.push(normalizePypiName(value));
  }
  // `extra` only inside quoted values: not a clause, but not one this reads either.
  return recognised === 0 ? [] : found;
}

export interface RequirementLine {
  name: string;
  extras: string[];
  /** The extras the line is gated on; null when it is not extra-gated. */
  gate: string[] | null;
  /** The PEP 440 specifier the line asks for (`"*"` for none); null for a
   *  direct reference (`name @ url`), which is never a registry edge. */
  range: string | null;
}

const REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?/;

/** One Requires-Dist value (`uvicorn[standard] (>=0.30) ; extra == "web"`),
 *  split only at its first `;` (the marker), which is all wheel METADATA and
 *  PyPI's `requires_dist` need: no `name @ url` with a `;` in the URL, no
 *  comments or line continuations as in a requirements file. Null when it
 *  names no valid project. */
export function requirementLine(value: string): RequirementLine | null {
  const match = value.match(REQUIREMENT);
  if (!match || !PROJECT_NAME.test(match[1])) return null;
  const semicolon = value.indexOf(";", match[0].length);
  const spec = (semicolon === -1 ? value.slice(match[0].length) : value.slice(match[0].length, semicolon)).trim();
  const bare = spec.startsWith("(") && spec.endsWith(")") ? spec.slice(1, -1).trim() : spec;
  return {
    name: normalizePypiName(match[1]),
    // A malformed extras list still installs the package, just none of its extras.
    extras: match[2] === undefined ? [] : (parseExtras(match[2]) ?? []),
    gate: semicolon === -1 ? null : markerExtras(value.slice(semicolon + 1)),
    range: bare.startsWith("@") ? null : bare === "" ? "*" : bare,
  };
}

function requirementLines(metadataText: string): { self: string | null; lines: RequirementLine[] } {
  let self: string | null = null;
  const lines: RequirementLine[] = [];
  for (const line of metadataText.split(/\r?\n/)) {
    // The headers end at the first truly empty line; the description
    // follows. A whitespace-only line is a folded header's continuation.
    if (line === "") break;
    if (line.startsWith("Name:")) {
      const name = line.slice("Name:".length).trim();
      if (self === null && PROJECT_NAME.test(name)) self = normalizePypiName(name);
      continue;
    }
    if (!line.startsWith("Requires-Dist:")) continue;
    const parsed = requirementLine(line.slice("Requires-Dist:".length).trim());
    if (parsed) lines.push(parsed);
  }
  return { self, lines };
}

/**
 * The lines an install of the package `self` with `extras` follows: every
 * line without an `extra == "…"` marker clause, plus the lines whose marker
 * names one of the install's extras (other marker clauses are ignored, so a
 * requested extra's lines are included on every platform). A line gated on
 * any other extra is skipped. A line naming the package itself
 * (`celery[redis]; extra == "all"`) adds those extras to this install
 * instead, and is not returned. `plain`: the install has no extras, so its
 * dependencies are installed bare.
 */
export function followedLines(
  self: string | null,
  lines: readonly RequirementLine[],
  extras: readonly string[],
): { lines: RequirementLine[]; plain: boolean } {
  const requested = new Set(extras.map(normalizePypiName));
  const plain = requested.size === 0;
  const included = (line: RequirementLine) => line.gate === null || line.gate.some((extra) => requested.has(extra));
  for (let grew = !plain; grew;) {
    grew = false;
    for (const line of lines) {
      if (line.name !== self || !included(line)) continue;
      for (const extra of line.extras) {
        if (requested.size >= MAX_EXTRAS || requested.has(extra)) continue;
        requested.add(extra);
        grew = true;
      }
    }
  }
  return { lines: lines.filter((line) => line.name !== self && included(line)), plain };
}

/**
 * The dependencies a wheel's METADATA declares for an install of the package
 * with `extras` (see `followedLines`). Each dependency carries the extras its
 * line asks of it (`uvicorn[standard]`). Names and extras are validated and
 * normalized.
 *
 * Policy, not pip: a plain install (no `extras`) follows no extras at all,
 * neither its own (a self-referencing line) nor its dependencies' — each
 * dependency comes back bare, so extras are followed only along a chain that
 * starts at an allowlist entry naming extras.
 */
export function requiredDists(metadataText: string, extras: readonly string[] = []): FileDependency[] {
  const { self, lines } = requirementLines(metadataText);
  const followed = followedLines(self, lines, extras);
  const out = new Map<string, Set<string>>();
  for (const line of followed.lines) {
    const merged = out.get(line.name) ?? new Set<string>();
    if (!followed.plain) for (const extra of line.extras) if (merged.size < MAX_EXTRAS) merged.add(extra);
    out.set(line.name, merged);
  }
  return [...out].map(([name, merged]) => ({ name, extras: [...merged].sort() }));
}

/** Dependency names a METADATA declares for a plain install (no extras). */
export function requiresDist(metadataText: string): string[] {
  return requiredDists(metadataText).map((dependency) => dependency.name);
}
