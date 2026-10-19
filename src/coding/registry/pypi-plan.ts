/**
 * PyPI lockfile verification hooks (`POST /registry/pypi/-/plan`): parsing a
 * `uv.lock` or a pinned requirements file (`pip-compile`, `uv pip compile`,
 * `pip freeze`) into entries, and reading each pinned release's facts from
 * PyPI's JSON API. Nothing here decides anything: the registry core verifies
 * every claim against these registry reads (plan.ts).
 *
 * Approvals are names (`approves: "names"`): a release has many files, and
 * every download keeps the usual per-file checks (wheels only, per-file
 * release age, the index's sha256). No lockfile integrity is compared
 * (`integrity: "registry"`); pip and uv check the hashes a lockfile records
 * themselves.
 *
 * Kept free of imports from pypi.ts, which imports this module.
 */
import { eq as pepEq, satisfies as pepSatisfies, valid as pepValid } from "@renovatebot/pep440";
import { parse as parseToml } from "smol-toml";
import { badRequest, tooLarge } from "./lockfile-shared.js";
import {
  followedLines,
  isPypiProjectName,
  normalizePypiName,
  requirementLine,
  type RequirementLine,
} from "./pypi-requirements.js";
import {
  RegistryError,
  type DeclaredDependency,
  type LockfileEntry,
  type LockfilePlanSupport,
  type ParsedLockfile,
  type UpstreamFetch,
  type VersionFact,
} from "./types.js";

const JSON_API = "https://pypi.org/pypi/";
/** The index URLs a registry package in a uv.lock may name (besides the proxy's own). */
const PUBLIC_INDEXES = ["https://pypi.org/simple", "https://pypi.org/simple/"];
/** The most dependency lines read from one release. */
const MAX_REQUIRES_DIST = 2000;

function unsupported(message: string): RegistryError {
  return new RegistryError(400, "wardby_lockfile_unsupported", message);
}

/** A registry entry for `name==version`, or an unsupported one when either is not valid. */
function entryOf(name: string, version: string): LockfileEntry {
  const path = `${normalizePypiName(name)}@${version}`;
  if (!isPypiProjectName(name) || pepValid(version) === null)
    return {
      path,
      name,
      version,
      integrity: null,
      kind: "unsupported",
      unsupportedReason: "not a valid Python project name and exact version",
    };
  return { path, name: normalizePypiName(name), version, integrity: null, kind: "registry" };
}

function unsupportedEntry(name: string, version: string, reason: string): LockfileEntry {
  const normalized = isPypiProjectName(name) ? normalizePypiName(name) : name;
  return {
    path: `${normalized}@${version}`,
    name: normalized,
    version,
    integrity: null,
    kind: "unsupported",
    unsupportedReason: reason,
  };
}

/** Entries by name, for a lockfile with no per-parent pins (a requirements file). */
function byName(entries: readonly LockfileEntry[]): Map<string, LockfileEntry[]> {
  const names = new Map<string, LockfileEntry[]>();
  for (const entry of entries) names.set(entry.name, [...(names.get(entry.name) ?? []), entry]);
  return names;
}

// --- requirements files ------------------------------------------------------

/** One logical line of a requirements file: continuations joined, the comment removed. */
function logicalLines(body: string): string[] {
  const lines: string[] = [];
  let pending = "";
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1)} `;
      continue;
    }
    lines.push(pending + line);
    pending = "";
  }
  if (pending) lines.push(pending);
  // A comment starts at a `#` at the line's start or after whitespace (pip's rule).
  return lines.map((line) => line.replace(/(^|\s)#.*$/, "").trim()).filter((line) => line !== "");
}

/** The requirement part of a line: everything before its first per-requirement option (`--hash=…`). */
function requirementPart(line: string): string {
  const option = line.search(/\s--?[A-Za-z]/);
  return (option === -1 ? line : line.slice(0, option)).trim();
}

const PINNED = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/;

/**
 * A pinned requirements file: every `name==version` (or `===`) line is an
 * entry; a direct reference (`name @ url`) is an unsupported one. Options
 * (`-r`, `-c`, `--index-url`, …), editable or local projects and unpinned
 * lines are not entries: pip resolves those the usual way. The file records
 * no dependency graph, so a parent's dependency resolves to every entry of
 * that name (marker-split pins).
 */
export function parseRequirements(body: string, maxEntries: number): ParsedLockfile {
  const entries: LockfileEntry[] = [];
  for (const line of logicalLines(body)) {
    if (line.startsWith("-")) continue;
    const requirement = requirementPart(line);
    const match = requirement.match(PINNED);
    if (!match) continue;
    const name = match[1];
    const spec = match[2].split(";")[0].trim();
    if (spec.startsWith("@")) {
      entries.push(unsupportedEntry(name, "url", "installed from a URL, not the package registry"));
      continue;
    }
    const pin = spec.match(/^===?\s*([^\s,;*]+)$/);
    if (!pin) continue;
    entries.push(entryOf(name, pin[1]));
    if (entries.length > maxEntries) throw tooLarge(entries.length, maxEntries);
  }
  const unique = [...new Map(entries.map((entry) => [entry.path, entry])).values()];
  const names = byName(unique);
  return {
    entries: unique,
    projects: [],
    integrity: "registry",
    resolve: (_from, key) => names.get(key)?.[0],
    resolveAll: (_from, key) => names.get(key) ?? [],
  };
}

// --- uv.lock -------------------------------------------------------------------

interface UvDependency {
  name?: unknown;
  version?: unknown;
}
interface UvPackage {
  name?: unknown;
  version?: unknown;
  source?: unknown;
  dependencies?: unknown;
  "optional-dependencies"?: unknown;
  "dev-dependencies"?: unknown;
}

/** Every `{ name, version? }` a package's dependency lists name (all groups and extras). */
function lockDependencies(pkg: UvPackage): { name: string; version?: string }[] {
  const lists: unknown[] = [pkg.dependencies];
  for (const field of ["optional-dependencies", "dev-dependencies"] as const) {
    const groups = pkg[field];
    if (groups && typeof groups === "object" && !Array.isArray(groups))
      lists.push(...Object.values(groups as Record<string, unknown>));
  }
  const out: { name: string; version?: string }[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list as UvDependency[]) {
      if (typeof item?.name !== "string" || !isPypiProjectName(item.name)) continue;
      out.push({
        name: normalizePypiName(item.name),
        ...(typeof item.version === "string" ? { version: item.version } : {}),
      });
    }
  }
  return out;
}

/**
 * A uv.lock (`version = 1`). A package from PyPI (or the proxy) is an
 * entry; the lock's own projects (editable, virtual and directory sources)
 * are its projects; one from git, a URL, a path or another index is
 * unsupported. A dependency resolves to the version the lock names for it
 * when the lock pins the name at several versions.
 */
export function parseUvLock(body: string, maxEntries: number, proxyRegistryUrl: string): ParsedLockfile {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(body);
  } catch {
    throw badRequest("the uv.lock is not valid TOML");
  }
  if (doc.version !== 1) throw unsupported(`uv.lock version ${String(doc.version)} is not supported (version 1 is)`);
  const packages = Array.isArray(doc.package) ? (doc.package as UvPackage[]) : [];
  if (packages.length > maxEntries) throw tooLarge(packages.length, maxEntries);
  const indexes = new Set([...PUBLIC_INDEXES, `${proxyRegistryUrl}simple`, `${proxyRegistryUrl}simple/`]);
  const entries: LockfileEntry[] = [];
  const projects: { path: string; dependencies: DeclaredDependency[] }[] = [];
  const pins = new Map<string, Map<string, string | undefined>>();
  for (const pkg of packages) {
    if (typeof pkg?.name !== "string") throw badRequest("a uv.lock package has no name");
    const name = pkg.name;
    const version = typeof pkg.version === "string" ? pkg.version : "";
    const source = pkg.source && typeof pkg.source === "object" ? (pkg.source as Record<string, unknown>) : {};
    const dependencies = lockDependencies(pkg);
    const path = `${isPypiProjectName(name) ? normalizePypiName(name) : name}@${version}`;
    pins.set(path, new Map(dependencies.map((dependency) => [dependency.name, dependency.version])));
    if ("editable" in source || "virtual" in source || "directory" in source) {
      projects.push({
        path,
        dependencies: dependencies.map((dependency) => ({ key: dependency.name, name: dependency.name, range: "*" })),
      });
      continue;
    }
    if (typeof source.registry !== "string") {
      entries.push(unsupportedEntry(name, version, "installed from git, a URL or a path, not the package registry"));
      continue;
    }
    if (!indexes.has(source.registry)) {
      entries.push(unsupportedEntry(name, version, "locked from another package index"));
      continue;
    }
    entries.push(entryOf(name, version));
  }
  const names = byName(entries);
  const resolve = (from: string, key: string): LockfileEntry | undefined => {
    const candidates = names.get(key);
    if (!candidates || candidates.length <= 1) return candidates?.[0];
    const pinned = pins.get(from)?.get(key);
    return pinned === undefined ? candidates[0] : candidates.find((entry) => entry.version === pinned);
  };
  return { entries, projects, integrity: "registry", resolve };
}

// --- format detection ----------------------------------------------------------

/** Which file a plan body is: a uv.lock, a requirements file, or one this registry cannot verify. */
export function parsePypiLockfile(
  body: string,
  options: { maxEntries: number; proxyRegistryUrl: string },
): ParsedLockfile {
  const text = body.startsWith("﻿") ? body.slice(1) : body;
  if (/^# This file is automatically @generated by Poetry/m.test(text) || /^content-hash\s*=/m.test(text))
    throw unsupported("Poetry lockfiles are not verified; install from a requirements file or uv.lock instead");
  if (/^lock-version\s*=/m.test(text))
    throw unsupported("pylock.toml files are not verified; install from a requirements file or uv.lock instead");
  if (/^\[\[package\]\]\s*$/m.test(text) || /^version\s*=\s*\d+\s*$/m.test(text))
    return parseUvLock(text, options.maxEntries, options.proxyRegistryUrl);
  return parseRequirements(text, options.maxEntries);
}

// --- registry reads ------------------------------------------------------------

interface JsonFile {
  packagetype?: unknown;
  filename?: unknown;
  url?: unknown;
  yanked?: unknown;
  upload_time_iso_8601?: unknown;
  digests?: { sha256?: unknown };
}

/** The release's wheels PyPI still serves, each with its upload time and sha256. */
function wheelsOf(urls: unknown): { url: string; sha256: string; uploadedAt: Date | null }[] {
  if (!Array.isArray(urls)) return [];
  return (urls as JsonFile[]).flatMap((file) => {
    if (file?.packagetype !== "bdist_wheel" || file.yanked === true) return [];
    if (typeof file.filename !== "string" || !file.filename.endsWith(".whl") || typeof file.url !== "string") return [];
    const sha256 = typeof file.digests?.sha256 === "string" ? file.digests.sha256 : "";
    const time = typeof file.upload_time_iso_8601 === "string" ? Date.parse(file.upload_time_iso_8601) : NaN;
    return [{ url: file.url, sha256, uploadedAt: Number.isNaN(time) ? null : new Date(time) }];
  });
}

/** The earliest upload among `wheels`, or null when none records one. */
function earliest(wheels: readonly { uploadedAt: Date | null }[]): Date | null {
  const times = wheels.flatMap((wheel) => (wheel.uploadedAt ? [wheel.uploadedAt.getTime()] : []));
  return times.length === 0 ? null : new Date(Math.min(...times));
}

async function fetchRelease(
  name: string,
  version: string,
  upstream: UpstreamFetch,
  signal?: AbortSignal,
): Promise<{ info: Record<string, unknown>; urls: unknown } | null> {
  const response = await upstream(`${JSON_API}${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`, {
    accept: "application/json",
    signal,
  });
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.ok) throw new RegistryError(502, "wardby_upstream_error", `PyPI returned ${response.status}`);
  const doc = (await response.json()) as { info?: unknown; urls?: unknown };
  if (!doc.info || typeof doc.info !== "object") return null;
  const info = doc.info as Record<string, unknown>;
  // The release must be exactly the one the lockfile pins.
  if (typeof info.name !== "string" || normalizePypiName(info.name) !== name) return null;
  if (typeof info.version !== "string" || !safeEq(info.version, version)) return null;
  return { info, urls: doc.urls };
}

function safeEq(a: string, b: string): boolean {
  try {
    return pepEq(a, b);
  } catch {
    return a === b;
  }
}

/** One release's facts: its dependency lines (with their extras and extra
 *  gates), and its earliest wheel's upload time, URL and sha256. A release
 *  with no wheel is refused (`wardby_file_not_allowed`): nothing in it may
 *  be installed. */
export async function fetchPypiVersionFact(
  name: string,
  version: string,
  upstream: UpstreamFetch,
  signal?: AbortSignal,
): Promise<VersionFact | null> {
  const release = await fetchRelease(name, version, upstream, signal);
  if (!release) return null;
  const wheels = wheelsOf(release.urls);
  if (wheels.length === 0)
    throw new RegistryError(
      403,
      "wardby_file_not_allowed",
      `${name} ${version} has no wheel on PyPI (only a source distribution), and only wheels are installed`,
    );
  const publishedAt = earliest(wheels);
  const first = wheels.find((wheel) => wheel.uploadedAt?.getTime() === publishedAt?.getTime()) ?? wheels[0];
  const lines = Array.isArray(release.info.requires_dist) ? release.info.requires_dist.slice(0, MAX_REQUIRES_DIST) : [];
  const dependencies: DeclaredDependency[] = [];
  for (const value of lines) {
    const line = typeof value === "string" ? requirementLine(value.trim()) : null;
    if (!line || line.range === null) continue;
    dependencies.push({
      key: line.name,
      name: line.name,
      range: line.range,
      ...(line.extras.length > 0 ? { extras: line.extras } : {}),
      ...(line.gate !== null ? { when: line.gate } : {}),
    });
  }
  return {
    name,
    version,
    publishedAt,
    integrity: /^[0-9a-f]{64}$/.test(first.sha256)
      ? `sha256-${Buffer.from(first.sha256, "hex").toString("base64")}`
      : "",
    downloadUrl: first.url,
    dependencies,
  };
}

/** Publish times for releases whose fact carried none (no wheel recorded an upload time). */
export async function fetchPypiPublishTimes(
  name: string,
  versions: readonly string[],
  upstream: UpstreamFetch,
  options: { signal: AbortSignal },
): Promise<Map<string, Date>> {
  const times = new Map<string, Date>();
  for (const version of versions) {
    const release = await fetchRelease(name, version, upstream, options.signal);
    const time = release ? earliest(wheelsOf(release.urls)) : null;
    if (time) times.set(version, time);
  }
  return times;
}

/** Whether a locked version is inside a dependency line's specifier, a
 *  pinned pre-release included. */
export function pypiEdgeSatisfies(version: string, range: string): boolean {
  if (range === "*" || range === "") return true;
  try {
    return pepSatisfies(version, range, { prereleases: true });
  } catch {
    return false;
  }
}

/** The dependencies a release installed with `extras` follows, under the
 *  same extras policy as the graph walk (pypi-requirements.ts). */
export function pypiDependenciesOf(fact: VersionFact, extras: readonly string[]): DeclaredDependency[] {
  const lines: RequirementLine[] = fact.dependencies.map((dependency) => ({
    name: dependency.name,
    extras: [...(dependency.extras ?? [])],
    gate: dependency.when ? [...dependency.when] : null,
    range: dependency.range,
  }));
  const followed = followedLines(fact.name, lines, extras);
  return followed.lines.map((line) => ({
    key: line.name,
    name: line.name,
    range: line.range ?? "*",
    ...(!followed.plain && line.extras.length > 0 ? { extras: line.extras } : {}),
  }));
}

export const pypiLockfilePlan: LockfilePlanSupport = {
  approves: "names",
  parse: parsePypiLockfile,
  fetchVersionFact: fetchPypiVersionFact,
  fetchPublishTimes: fetchPypiPublishTimes,
  edgeSatisfies: pypiEdgeSatisfies,
  dependenciesOf: pypiDependenciesOf,
};

// --- uv.lock URLs ----------------------------------------------------------------

/** PyPI's own path for a file by project and filename, which redirects to the
 *  file (a wheel's python tag, or `source` for an sdist). */
export function publicFileUrl(name: string, filename: string): string | undefined {
  if (!isPypiProjectName(name) || !/^[A-Za-z0-9._+!-]+$/.test(filename)) return undefined;
  let tag = "source";
  if (filename.endsWith(".whl")) {
    const parts = filename.slice(0, -".whl".length).split("-");
    if (parts.length < 5) return undefined;
    tag = parts[parts.length - 3];
  } else if (!/\.(?:tar\.gz|zip)$/.test(filename)) return undefined;
  return `https://files.pythonhosted.org/packages/${tag}/${name[0]}/${name}/${filename}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodedOrUndefined(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/**
 * A uv.lock with the proxy's URLs (which uv records when it locks through
 * the proxy) put back to PyPI's: its index as `https://pypi.org/simple`, each
 * file as PyPI's redirecting path (publicFileUrl). Credentials are never in
 * them (uv records none), but any userinfo before the proxy host is dropped
 * with the URL anyway. Everything else is left exactly as it was.
 */
export function normalizeUvLock(content: string, registryUrl: string): string {
  const at = registryUrl.indexOf("://");
  if (at < 0) return content;
  const scheme = escapeRegExp(registryUrl.slice(0, at + 3));
  const rest = escapeRegExp(registryUrl.slice(at + 3));
  const base = `${scheme}(?:[^@/"\\s]*@)?${rest}`;
  return content
    .replace(new RegExp(`"${base}simple/?"`, "g"), `"${PUBLIC_INDEXES[0]}"`)
    .replace(new RegExp(`"${base}files/([^/"]+)/([^/"]+)"`, "g"), (match, rawName: string, rawFile: string) => {
      const name = decodedOrUndefined(rawName);
      const filename = decodedOrUndefined(rawFile);
      const url = name && filename ? publicFileUrl(name, filename) : undefined;
      return url ? `"${url}"` : match;
    });
}
