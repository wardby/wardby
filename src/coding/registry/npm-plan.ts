/**
 * npm lockfile verification hooks (`POST /registry/npm/-/plan`): parsing a
 * package-lock.json (lockfileVersion 2 or 3) into entries and npm's own
 * node_modules resolution rule, and reading the registry's per-version
 * facts and publish times. Nothing here decides anything: the registry core
 * verifies every claim against these registry reads (plan.ts).
 *
 * Kept free of imports from npm.ts, which imports this module.
 */
import semver from "semver";
import { PACKAGE_NAME } from "./npm-lockfile.js";
import { JsonMemberTooLarge, scanTopLevelMember } from "./json-scan.js";
import {
  RegistryError,
  type DeclaredDependency,
  type LockfileEntry,
  type LockfilePlanSupport,
  type ParsedLockfile,
  type UpstreamFetch,
  type VersionFact,
} from "./types.js";

const UPSTREAM = "https://registry.npmjs.org/";
const NODE_MODULES = "node_modules/";
/** The largest `time` object kept from a packument (a package with tens of
 *  thousands of versions has a few MB of it). */
const MAX_TIME_TEXT = 16 * 1024 * 1024;

/** A declared semver range as written, or `"*"` for anything that is not
 *  a valid range (a dist-tag such as `latest`, an empty spec): npm
 *  resolves those to some published version, so any version counts. */
function rangeOf(spec: string): string {
  return spec !== "" && semver.validRange(spec) ? spec : "*";
}

/** The registry dependencies a manifest's dependency map declares: each
 *  one's install folder (`key`), the registry package it installs (an
 *  alias `"string-width-cjs": "npm:string-width@^4"` installs its target,
 *  under the alias's own range) and its range. A spec that isn't fetched
 *  from the registry at all (`file:`, `link:`, a path, `git`/`git+…`, an
 *  `http(s):` tarball, `github:`/`user/repo` shorthands, `workspace:`)
 *  contributes nothing: every such spec contains a `:` or a `/`, which no
 *  semver range or dist-tag does. */
export function registryDependencyEdges(deps: unknown): DeclaredDependency[] {
  const edges: DeclaredDependency[] = [];
  if (!deps || typeof deps !== "object") return edges;
  for (const [key, rawSpec] of Object.entries(deps as Record<string, unknown>)) {
    const spec = typeof rawSpec === "string" ? rawSpec.trim() : "";
    if (spec.startsWith("npm:")) {
      const target = spec.slice("npm:".length);
      const at = target.indexOf("@", 1);
      const name = at > 0 ? target.slice(0, at) : target;
      if (PACKAGE_NAME.test(name)) edges.push({ key, name, range: rangeOf(at > 0 ? target.slice(at + 1) : "") });
      continue;
    }
    if (/[:/]/.test(spec)) continue;
    edges.push({ key, name: key, range: rangeOf(spec) });
  }
  return edges;
}

/** Every registry dependency a manifest declares, in npm's install order
 *  (dependencies, optionalDependencies, peerDependencies), once per
 *  install folder: npm lists an optional dependency under `dependencies`
 *  too, and the first declaration of a folder is the one npm uses. */
export function declaredDependencies(
  manifest: Record<string, unknown>,
  fields: readonly string[],
): DeclaredDependency[] {
  const byKey = new Map<string, DeclaredDependency>();
  for (const field of fields) {
    for (const edge of registryDependencyEdges(manifest[field])) if (!byKey.has(edge.key)) byKey.set(edge.key, edge);
  }
  return [...byKey.values()];
}

const PUBLISHED_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;
/** A project's own declarations, dev dependencies included (they are
 *  installed for the project, never for a dependency). */
const PROJECT_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

function badRequest(message: string): RegistryError {
  return new RegistryError(400, "wardby_bad_request", message);
}

/** The folder a `node_modules/...` path installs, e.g. `@s/a` for
 *  `node_modules/x/node_modules/@s/a`; undefined for a path outside any
 *  node_modules folder (a workspace project). */
function installFolder(path: string): string | undefined {
  const at = path.lastIndexOf(NODE_MODULES);
  if (at < 0 || (at > 0 && path[at - 1] !== "/")) return undefined;
  return path.slice(at + NODE_MODULES.length);
}

/** Whether `resolved` names a registry download: the public registry, or
 *  the proxy's own npm route (a lockfile written through the proxy before
 *  it is normalized at collection). A missing `resolved` is a registry
 *  entry too: npm omits it for one it will fetch from the registry. */
function fromRegistry(resolved: unknown, proxyRegistryUrl: string): boolean {
  if (resolved === undefined) return true;
  if (typeof resolved !== "string") return false;
  return resolved.startsWith(UPSTREAM) || resolved.startsWith(proxyRegistryUrl);
}

export function parseNpmLockfile(
  body: string,
  options: { maxEntries: number; proxyRegistryUrl: string },
): ParsedLockfile {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    throw badRequest("the lockfile is not valid JSON");
  }
  if (!document || typeof document !== "object" || Array.isArray(document))
    throw badRequest("the lockfile is not a JSON object");
  const lock = document as { lockfileVersion?: unknown; packages?: unknown };
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) {
    throw new RegistryError(
      400,
      "wardby_lockfile_unsupported",
      `lockfileVersion ${JSON.stringify(lock.lockfileVersion ?? null)} is not supported; regenerate the lockfile with npm 7 or later (lockfileVersion 2 or 3)`,
    );
  }
  if (!lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages))
    throw new RegistryError(400, "wardby_lockfile_unsupported", "the lockfile has no `packages` section");
  const packages = lock.packages as Record<string, unknown>;
  const count = Object.keys(packages).length - ("" in packages ? 1 : 0);
  if (count > options.maxEntries) {
    throw new RegistryError(
      413,
      "wardby_lockfile_too_large",
      `the lockfile has ${count} entries; at most ${options.maxEntries} are verified (REGISTRY_PLAN_MAX_ENTRIES)`,
    );
  }

  const entries: LockfileEntry[] = [];
  const byPath = new Map<string, LockfileEntry>();
  /** Paths of link entries (symlinks to local projects): a dependency
   *  resolving to one is local, not a registry entry. */
  const links = new Set<string>();
  const projects: { path: string; dependencies: DeclaredDependency[] }[] = [];
  for (const [path, raw] of Object.entries(packages)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw badRequest(`lockfile entry "${path}" is not an object`);
    const value = raw as Record<string, unknown>;
    const folder = installFolder(path);
    if (path === "" || folder === undefined) {
      // The root project, or a workspace project's own folder.
      projects.push({ path, dependencies: declaredDependencies(value, PROJECT_FIELDS) });
      continue;
    }
    if (value.link === true) {
      links.add(path);
      continue;
    }
    const name = typeof value.name === "string" ? value.name : folder;
    const version = typeof value.version === "string" ? value.version : "";
    const integrity = typeof value.integrity === "string" ? value.integrity : null;
    let entry: LockfileEntry;
    if (value.inBundle === true) {
      entry = { path, name, version, integrity, kind: "bundled" };
    } else if (!PACKAGE_NAME.test(name) || semver.valid(version) !== version) {
      entry = {
        path,
        name,
        version,
        integrity,
        kind: "unsupported",
        unsupportedReason: "not a registry package name and exact version",
      };
    } else if (!fromRegistry(value.resolved, options.proxyRegistryUrl)) {
      entry = {
        path,
        name,
        version,
        integrity,
        kind: "unsupported",
        unsupportedReason: "installed from outside the npm registry",
      };
    } else {
      entry = { path, name, version, integrity, kind: "registry" };
    }
    entries.push(entry);
    byPath.set(path, entry);
  }

  const resolve = (fromPath: string, key: string): LockfileEntry | undefined => {
    let directory = fromPath;
    for (;;) {
      const candidate = `${directory === "" ? "" : `${directory}/`}${NODE_MODULES}${key}`;
      if (links.has(candidate)) return undefined;
      const found = byPath.get(candidate);
      if (found) return found;
      if (directory === "") return undefined;
      const slash = directory.lastIndexOf("/");
      directory = slash < 0 ? "" : directory.slice(0, slash);
    }
  };
  return { entries, projects, resolve };
}

function encodedName(name: string): string {
  return name.replaceAll("/", "%2f");
}

/** npm's SRI integrity for a dist record: `integrity` as published, or,
 *  for a version published before npm recorded one, its sha1 `shasum` in
 *  SRI form (what npm itself records in a lockfile for such a version). */
function distIntegrity(dist: unknown): string {
  if (!dist || typeof dist !== "object") return "";
  const { integrity, shasum } = dist as { integrity?: unknown; shasum?: unknown };
  if (typeof integrity === "string" && integrity.trim() !== "") return integrity.trim();
  if (typeof shasum === "string" && /^[a-f0-9]{40}$/.test(shasum))
    return `sha1-${Buffer.from(shasum, "hex").toString("base64")}`;
  return "";
}

export async function fetchNpmVersionFact(
  name: string,
  version: string,
  upstream: UpstreamFetch,
  signal?: AbortSignal,
): Promise<VersionFact | null> {
  const response = await upstream(`${UPSTREAM}${encodedName(name)}/${encodeURIComponent(version)}`, {
    accept: "application/json",
    signal,
  });
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.ok) throw new RegistryError(502, "wardby_upstream_error", `npm returned ${response.status}`);
  const doc = (await response.json()) as Record<string, unknown>;
  // The registry also answers a dist-tag here (`/react/latest`), and a
  // lockfile version is exact, so the answer must be that exact version.
  if (doc.name !== name || doc.version !== version) return null;
  const dist = doc.dist as { tarball?: unknown } | undefined;
  return {
    name,
    version,
    publishedAt: null,
    integrity: distIntegrity(dist),
    downloadUrl: typeof dist?.tarball === "string" ? dist.tarball : "",
    dependencies: declaredDependencies(doc, PUBLISHED_FIELDS),
  };
}

export async function fetchNpmPublishTimes(
  name: string,
  versions: readonly string[],
  upstream: UpstreamFetch,
  options: { maxBytes: number; signal: AbortSignal },
): Promise<Map<string, Date>> {
  const response = await upstream(`${UPSTREAM}${encodedName(name)}`, {
    accept: "application/json",
    acceptEncoding: "gzip",
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new RegistryError(
      response.status === 404 ? 404 : 502,
      response.status === 404 ? "wardby_package_not_found" : "wardby_upstream_error",
      `npm returned ${response.status} for "${name}"`,
    );
  }
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  let body = response.body as ReadableStream<Uint8Array>;
  if (encoding === "gzip") body = body.pipeThrough(new DecompressionStream("gzip"));
  else if (encoding && encoding !== "identity") {
    await body.cancel().catch(() => undefined);
    throw new RegistryError(502, "wardby_upstream_error", `npm answered with an unsupported content-encoding`);
  }
  let time: unknown;
  try {
    // maxBytes bounds the decompressed document, so a small compressed
    // body cannot expand without limit.
    time = await scanTopLevelMember(body, "time", { maxBytes: options.maxBytes, maxValueLength: MAX_TIME_TEXT });
  } catch (error) {
    if (error instanceof JsonMemberTooLarge)
      throw new RegistryError(502, "wardby_metadata_too_large", `npm metadata for "${name}" is too large`);
    throw error;
  }
  const times = new Map<string, Date>();
  if (!time || typeof time !== "object") return times;
  for (const version of versions) {
    const value = (time as Record<string, unknown>)[version];
    if (typeof value !== "string") continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) times.set(version, date);
  }
  return times;
}

/** npm's own rule for whether a locked version satisfies a declared range
 *  (arborist's dep-valid): `*` and dist-tags accept any version, otherwise
 *  a loose semver match. */
export function npmEdgeSatisfies(version: string, range: string): boolean {
  if (range === "*" || range === "") return true;
  try {
    return semver.satisfies(version, range, { loose: true });
  } catch {
    return false;
  }
}

export const npmLockfilePlan: LockfilePlanSupport = {
  parse: parseNpmLockfile,
  fetchVersionFact: fetchNpmVersionFact,
  fetchPublishTimes: fetchNpmPublishTimes,
  edgeSatisfies: npmEdgeSatisfies,
};
