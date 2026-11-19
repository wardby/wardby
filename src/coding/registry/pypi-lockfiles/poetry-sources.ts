/**
 * Poetry source swap. Poetry ignores the URL a poetry.lock records and takes
 * the host from the `[[tool.poetry.source]]` tables of pyproject.toml, so a
 * project that names JFrog or PyPI cannot install in the sandbox. Before the
 * agent starts each source URL is swapped for the proxy's PyPI index and
 * `poetry lock` rewrites the lock (its `url` and `content-hash`); before
 * collection the originals are put back. Line level, like uv-lockfile.ts:
 * only the URL values change, comments and spacing stay.
 */

export interface PoetrySource {
  name: string;
  url: string;
}

export interface PoetrySourceSwap {
  content: string;
  /** The original sources, in file order. */
  sources: PoetrySource[];
}

const SOURCE_TABLE = "[[tool.poetry.source]]";
const LOCK_SOURCE_TABLE = "[package.source]";
const NAME = /^\s*name\s*=\s*(["'])(.*?)\1/;
const URL_LINE = /^(\s*url\s*=\s*)(["'])(.*?)\2/;
const TYPE = /^\s*type\s*=\s*(["'])(.*?)\1/;
const REFERENCE = /^\s*reference\s*=\s*(["'])(.*?)\1/;

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/$/, "") === b.replace(/\/$/, "");
}

function lookup(sources: PoetrySource[], name: string): PoetrySource | undefined {
  return sources.find((source) => source.name === name);
}

/** The line ranges `[start + 1, end)` under each table header equal to `header`. */
function tables(lines: string[], header: string): [number, number][] {
  const found: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() !== header) continue;
    let end = i + 1;
    while (end < lines.length && !lines[end].startsWith("[")) end++;
    found.push([i + 1, end]);
  }
  return found;
}

function find<T>(lines: string[], [start, end]: [number, number], read: (line: string) => T | null): T | null {
  for (let i = start; i < end; i++) {
    const value = read(lines[i]);
    if (value !== null) return value;
  }
  return null;
}

/** Rewrites the `url` value in `[start, end)` with what `next` returns for it (null keeps it). */
function setUrl(lines: string[], [start, end]: [number, number], next: (current: string) => string | null): void {
  for (let i = start; i < end; i++) {
    const match = lines[i].match(URL_LINE);
    if (!match) continue;
    const replacement = next(match[3]);
    if (replacement !== null)
      lines[i] = `${match[1]}${match[2]}${replacement}${match[2]}${lines[i].slice(match[0].length)}`;
    return;
  }
}

export function swapPoetrySources(content: string, proxyIndexUrl: string): PoetrySourceSwap {
  const lines = content.split("\n");
  const sources: PoetrySource[] = [];
  for (const range of tables(lines, SOURCE_TABLE)) {
    const name = find(lines, range, (line) => line.match(NAME)?.[2] ?? null);
    if (name === null) continue;
    setUrl(lines, range, (url) => {
      if (sameUrl(url, proxyIndexUrl)) return null;
      sources.push({ name, url });
      return proxyIndexUrl;
    });
  }
  return { content: lines.join("\n"), sources };
}

export function restorePoetrySources(content: string, sources: PoetrySource[], proxyIndexUrl: string): string {
  const lines = content.split("\n");
  for (const range of tables(lines, SOURCE_TABLE)) {
    const name = find(lines, range, (line) => line.match(NAME)?.[2] ?? null);
    const original = name === null ? undefined : lookup(sources, name);
    if (!original) continue;
    setUrl(lines, range, (url) => (sameUrl(url, proxyIndexUrl) ? original.url : null));
  }
  return lines.join("\n");
}

/** Puts the original URL back in the `[package.source]` tables of a poetry.lock that point at the proxy. */
export function restorePoetryLockUrls(content: string, sources: PoetrySource[], proxyIndexUrl: string): string {
  const lines = content.split("\n");
  for (const range of tables(lines, LOCK_SOURCE_TABLE)) {
    if (find(lines, range, (line) => line.match(TYPE)?.[2] ?? null) !== "legacy") continue;
    const reference = find(lines, range, (line) => line.match(REFERENCE)?.[2] ?? null);
    const original = reference === null ? undefined : lookup(sources, reference);
    if (!original) continue;
    setUrl(lines, range, (url) => (sameUrl(url, proxyIndexUrl) ? original.url : null));
  }
  return lines.join("\n");
}

/** The `<NAME>` of `POETRY_HTTP_BASIC_<NAME>_USERNAME` for a source: upper case, other characters `_`. */
export function poetrySourceEnvName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** A poetry.lock sits beside a pyproject.toml that configures Poetry. */
export function isPoetryProject(pyproject: string): boolean {
  return /^\[{1,2}tool\.poetry[.\]]/m.test(pyproject);
}

/** The `POETRY_HTTP_BASIC_*` variables that authenticate every swapped source to the proxy. */
export function poetryCredentialEnv(sources: PoetrySource[], token: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { name } of sources) {
    const prefix = `POETRY_HTTP_BASIC_${poetrySourceEnvName(name)}`;
    env[`${prefix}_USERNAME`] = "wardby";
    env[`${prefix}_PASSWORD`] = token;
  }
  return env;
}
