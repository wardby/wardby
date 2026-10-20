/**
 * yarn lockfiles for npm lockfile plans (`POST /registry/npm/-/plan`) and
 * for the rewrite of proxy URLs before collection:
 *
 * - yarn classic (1.x) `yarn.lock`, "# yarn lockfile v1": yarn's own
 *   indentation format, read here by a small line parser (no YAML). Each
 *   entry records the `resolved` download URL and npm's `integrity`.
 * - yarn Berry (2+) `yarn.lock`: YAML with a `__metadata` section. Each
 *   entry records `resolution: "name@npm:x.y.z"` and a `checksum`, which is
 *   yarn's own hash of its cache archive, not npm's integrity: entries are
 *   approved as exact name@version pairs, and each download is checked
 *   against the registry's own integrity (ParsedLockfile.integrity).
 *
 * yarn resolves a dependency by its descriptor (`name@range`, as the
 * parent's entry lists it), never by folder: `resolve` does the same.
 * Workspaces, `link:`, `portal:`, `file:`, `exec:` and `patch:` entries are
 * local (never fetched from the registry: a patch applies to an npm entry
 * listed in its own right) and skipped; git, URL and other non-registry
 * sources are refused. Nothing here decides anything: plan.ts verifies
 * every claim against the registry.
 *
 * Kept free of imports from npm.ts, which imports this module.
 */
import { parseProxyPath, publicNpmTarballUrl } from "./npm-lockfile.js";
import { registryDependencyEdges } from "./npm-plan.js";
import {
  YARN_CLASSIC_REGISTRY,
  badRequest,
  buildResolve,
  entryOf,
  fromRegistry,
  isLocal,
  mapOf,
  parseLockfileYaml,
  splitDescriptor,
  stringOf,
  tooLarge,
  yamlEntryLines,
  type Target,
} from "./lockfile-shared.js";
import { RegistryError, type DeclaredDependency, type LockfileEntry, type ParsedLockfile } from "./types.js";

/** A lockfile's line limit for the classic parser, far above any real one
 *  for the entry bound, so a pathological body is refused early. */
const MAX_LINES_PER_ENTRY = 64;

// --- yarn classic (v1) ---------------------------------------------------

/** One `key value`, `key:` or `"quoted key" "quoted value"` line, unquoted. */
function tokens(line: string, lineNumber: number): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < line.length) {
    if (line[at] === " ") {
      at += 1;
      continue;
    }
    if (line[at] === '"') {
      let end = at + 1;
      while (end < line.length && line[end] !== '"') end += line[end] === "\\" ? 2 : 1;
      if (end >= line.length) throw badRequest(`yarn.lock line ${lineNumber} has an unterminated string`);
      try {
        out.push(JSON.parse(line.slice(at, end + 1)) as string);
      } catch {
        throw badRequest(`yarn.lock line ${lineNumber} has an invalid string`);
      }
      at = end + 1;
    } else {
      let end = at;
      while (end < line.length && line[end] !== " ") end += 1;
      out.push(line.slice(at, end));
      at = end;
    }
  }
  return out;
}

/** The descriptors a header line (`"a@^1", a@^1.2:`) names. */
function headerDescriptors(header: string, lineNumber: number): string[] {
  if (!header.endsWith(":")) throw badRequest(`yarn.lock line ${lineNumber} is not an entry header`);
  return header
    .slice(0, -1)
    .split(/,\s*/)
    .map((part) => {
      const [descriptor, ...rest] = tokens(part.trim(), lineNumber);
      if (!descriptor || rest.length > 0) throw badRequest(`yarn.lock line ${lineNumber} has an invalid descriptor`);
      return descriptor;
    });
}

interface ClassicEntry {
  descriptors: string[];
  fields: Map<string, string>;
  dependencies: Map<string, string>;
}

function readClassic(body: string, maxEntries: number): ClassicEntry[] {
  const lines = body.split(/\r?\n/);
  if (lines.length > (maxEntries + 1) * MAX_LINES_PER_ENTRY) throw tooLarge(lines.length, maxEntries);
  const entries: ClassicEntry[] = [];
  let current: ClassicEntry | undefined;
  let section: Map<string, string> | undefined;
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim() === "" || line.startsWith("#")) return;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    if (indent === 0) {
      current = { descriptors: headerDescriptors(text, lineNumber), fields: new Map(), dependencies: new Map() };
      entries.push(current);
      if (entries.length > maxEntries) throw tooLarge(entries.length, maxEntries);
      section = undefined;
      return;
    }
    if (!current) throw badRequest(`yarn.lock line ${lineNumber} is outside any entry`);
    if (indent === 2) {
      if (text.endsWith(":")) {
        const [field] = tokens(text.slice(0, -1), lineNumber);
        // Only these two sections name what an entry installs.
        section =
          field === "dependencies" || field === "optionalDependencies"
            ? current.dependencies
            : new Map<string, string>();
        return;
      }
      const [field, value, ...rest] = tokens(text, lineNumber);
      if (field === undefined || value === undefined || rest.length > 0)
        throw badRequest(`yarn.lock line ${lineNumber} is not a "key value" pair`);
      current.fields.set(field, value);
      section = undefined;
      return;
    }
    if (indent === 4 && section) {
      const [key, value, ...rest] = tokens(text, lineNumber);
      if (key === undefined || value === undefined || rest.length > 0)
        throw badRequest(`yarn.lock line ${lineNumber} is not a "name range" pair`);
      section.set(key, value);
      return;
    }
    throw badRequest(`yarn.lock line ${lineNumber} has unexpected indentation`);
  });
  return entries;
}

export function parseYarnClassicLockfile(
  body: string,
  options: { maxEntries: number; proxyRegistryUrl: string },
): ParsedLockfile {
  const entries: LockfileEntry[] = [];
  const byPath = new Map<string, { dependencies: ReadonlyMap<string, string> }>();
  const byDescriptor = new Map<string, Target>();
  const referenced = new Set<string>();
  for (const raw of readClassic(body, options.maxEntries)) {
    for (const [key, range] of raw.dependencies) referenced.add(`${key}@${range}`);
    const path = raw.descriptors[0];
    if (byPath.has(path)) throw badRequest(`yarn.lock lists "${path}" twice`);
    const first = splitDescriptor(path);
    let target: Target = null;
    if (!isLocal(first.range)) {
      // An alias (`x-cjs@npm:x@^4`) installs its target.
      let name = first.name;
      if (first.range.startsWith("npm:")) name = splitDescriptor(first.range.slice("npm:".length)).name;
      const resolved = raw.fields.get("resolved");
      target = entryOf(
        path,
        name,
        raw.fields.get("version") ?? "",
        raw.fields.get("integrity") ?? null,
        resolved !== undefined && fromRegistry(resolved, options.proxyRegistryUrl) ? "registry" : "elsewhere",
      );
      entries.push(target);
    }
    byPath.set(path, { dependencies: raw.dependencies });
    for (const descriptor of raw.descriptors) {
      if (byDescriptor.has(descriptor)) throw badRequest(`yarn.lock lists "${descriptor}" twice`);
      byDescriptor.set(descriptor, target);
    }
  }
  return {
    entries,
    projects: classicProjects(byPath, byDescriptor, referenced),
    ...buildResolve(byPath, byDescriptor, (key, range) => [`${key}@${range}`]),
  };
}

/**
 * yarn classic records no project section: the root's and workspaces'
 * declarations live only in their package.json files. A descriptor no
 * entry depends on can only come from one of them, so those stand in for
 * the projects (one declaration per key each, so a name declared at two
 * ranges gives a second project). A descriptor a project shares with an
 * entry's dependency is not seen here. The stand-ins are added to `byPath`
 * under paths no entry uses, for `resolve`.
 */
function classicProjects(
  byPath: Map<string, { dependencies: ReadonlyMap<string, string> }>,
  byDescriptor: ReadonlyMap<string, Target>,
  referenced: ReadonlySet<string>,
): ParsedLockfile["projects"] {
  const layers: Map<string, string>[] = [];
  const seen = new Map<string, number>();
  for (const descriptor of byDescriptor.keys()) {
    if (referenced.has(descriptor)) continue;
    const { name: key, range } = splitDescriptor(descriptor);
    const at = seen.get(key) ?? 0;
    seen.set(key, at + 1);
    (layers[at] ??= new Map()).set(key, range);
  }
  const projects: { path: string; dependencies: DeclaredDependency[] }[] = [];
  layers.forEach((dependencies, at) => {
    const path = at === 0 ? "." : `.#${at}`;
    if (byPath.has(path)) return;
    byPath.set(path, { dependencies });
    projects.push({ path, dependencies: registryDependencyEdges(Object.fromEntries(dependencies)) });
  });
  return projects;
}

// --- yarn Berry ----------------------------------------------------------

/** `name@npm:1.2.3` (with any `::param=value` suffix), or null for another
 *  protocol. */
function npmResolution(resolution: string): { name: string; version: string; archiveUrl?: string } | null {
  const { name, range } = splitDescriptor(resolution);
  if (!range.startsWith("npm:")) return null;
  const [version, ...params] = range.slice("npm:".length).split("::");
  let archiveUrl: string | undefined;
  for (const param of params.join("&").split("&")) {
    if (param.startsWith("__archiveUrl=")) {
      try {
        archiveUrl = decodeURIComponent(param.slice("__archiveUrl=".length));
      } catch {
        archiveUrl = "";
      }
    }
  }
  return { name, version, ...(archiveUrl !== undefined ? { archiveUrl } : {}) };
}

/** The descriptors a Berry dependency (`key: range`) may be listed under,
 *  in order: a patch's own npm descriptor first (the patch entry itself is
 *  local), then as written, then with the default `npm:` protocol older
 *  lockfiles leave out. */
function berryCandidates(key: string, range: string): string[] {
  if (range.startsWith("patch:")) {
    const inner = range.slice("patch:".length).split("#")[0];
    try {
      return [decodeURIComponent(inner), `${key}@${range}`];
    } catch {
      return [`${key}@${range}`];
    }
  }
  return /^[a-z]+:/.test(range) ? [`${key}@${range}`] : [`${key}@${range}`, `${key}@npm:${range}`];
}

/** A workspace's declared registry dependencies, Berry's `npm:` protocol
 *  read as npm's own spec syntax. */
function berryDeclared(dependencies: Record<string, unknown>): DeclaredDependency[] {
  const specs: Record<string, string> = {};
  for (const [key, value] of Object.entries(dependencies)) {
    const range = stringOf(value);
    if (range === undefined) continue;
    if (!range.startsWith("npm:")) specs[key] = range;
    else {
      const rest = range.slice("npm:".length);
      specs[key] = rest.indexOf("@", 1) > 0 ? range : rest;
    }
  }
  return registryDependencyEdges(specs);
}

export function parseYarnBerryLockfile(
  document: Record<string, unknown>,
  options: { maxEntries: number; proxyRegistryUrl: string },
): ParsedLockfile {
  const metadataVersion = Number(stringOf(mapOf(document.__metadata).version));
  if (!Number.isInteger(metadataVersion) || metadataVersion < 4)
    throw new RegistryError(
      400,
      "wardby_lockfile_unsupported",
      "this yarn.lock comes from a yarn release before 2.0's stable format; regenerate it with yarn 2 or later",
    );
  const keys = Object.keys(document).filter((key) => key !== "__metadata");
  if (keys.length > options.maxEntries) throw tooLarge(keys.length, options.maxEntries);

  const entries: LockfileEntry[] = [];
  const projects: { path: string; dependencies: DeclaredDependency[] }[] = [];
  const byPath = new Map<string, { dependencies: ReadonlyMap<string, string> }>();
  const byDescriptor = new Map<string, Target>();
  for (const path of keys) {
    const value = document[path];
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw badRequest(`yarn.lock entry "${path}" is not a mapping`);
    const entry = value as Record<string, unknown>;
    const resolution = stringOf(entry.resolution);
    if (resolution === undefined) throw badRequest(`yarn.lock entry "${path}" has no resolution`);
    const declared = mapOf(entry.dependencies);
    const dependencies = new Map<string, string>();
    for (const [key, range] of Object.entries(declared)) if (typeof range === "string") dependencies.set(key, range);

    const { range: protocol } = splitDescriptor(resolution);
    const npm = npmResolution(resolution);
    let target: Target = null;
    if (npm) {
      const elsewhere = npm.archiveUrl !== undefined && !fromRegistry(npm.archiveUrl, options.proxyRegistryUrl);
      // Berry's checksum is not npm's integrity: none is claimed.
      target = entryOf(path, npm.name, npm.version, null, elsewhere ? "elsewhere" : "registry");
      entries.push(target);
    } else if (protocol.startsWith("workspace:")) {
      projects.push({ path, dependencies: berryDeclared(declared) });
    } else if (!isLocal(protocol)) {
      target = entryOf(path, splitDescriptor(resolution).name, stringOf(entry.version) ?? "", null, "elsewhere");
      entries.push(target);
    }
    byPath.set(path, { dependencies });
    for (const descriptor of path.split(/,\s*/)) {
      if (byDescriptor.has(descriptor)) throw badRequest(`yarn.lock lists "${descriptor}" twice`);
      byDescriptor.set(descriptor, target);
    }
  }
  return {
    entries,
    projects,
    integrity: "registry",
    ...buildResolve(byPath, byDescriptor, berryCandidates),
  };
}

/** A `yarn.lock` of either generation: classic when it carries the
 *  `# yarn lockfile v1` marker, Berry when it has a `__metadata` section. */
export function parseYarnLockfile(
  body: string,
  options: { maxEntries: number; proxyRegistryUrl: string },
): ParsedLockfile {
  if (isYarnClassicLockfile(body)) return parseYarnClassicLockfile(body, options);
  const lines = yamlEntryLines(body);
  if (lines > options.maxEntries * MAX_LINES_PER_ENTRY) throw tooLarge(lines, options.maxEntries);
  return parseYarnBerryLockfile(parseLockfileYaml(body), options);
}

/** Whether `body` is a yarn classic lockfile (its marker comment within
 *  the first lines). */
export function isYarnClassicLockfile(body: string): boolean {
  return /^# yarn lockfile v1\s*$/m.test(body.slice(0, 1024));
}

/** Whether `body` is a yarn Berry lockfile: a `__metadata:` mapping at the
 *  top level. */
export function isYarnBerryLockfile(body: string): boolean {
  return /^__metadata:\s*$/m.test(body);
}

// --- Rewrite before collection -------------------------------------------

/** A `  resolved "<url>"` line of a classic lockfile. */
const CLASSIC_RESOLVED = /^(\s+resolved\s+)"([^"\\]*)"(\s*)$/gm;
/** A Berry `resolution: "name@npm:x.y.z::params"` line. */
const BERRY_PARAMETERS = /^(\s+resolution:\s+"[^"\n]*?@npm:[^":\n]*)::([^"\n]*)(".*)$/gm;

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Rewrites what yarn records of the proxy in a `yarn.lock` to public URLs:
 * a classic lockfile's `resolved` URLs become yarn's default registry URL
 * for the same package and version (keeping the `#sha1` fragment yarn
 * appends), and a Berry lockfile's `__archiveUrl` parameter pointing at the
 * proxy is dropped (Berry records one only for a download URL other than
 * the registry's conventional one). Only matched values change.
 */
export function normalizeYarnLockfile(content: string, registryUrl: string): string {
  const base = registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`;
  if (isYarnClassicLockfile(content)) {
    return content.replace(CLASSIC_RESOLVED, (match, open: string, value: string, close: string) => {
      const hash = value.indexOf("#");
      const url = hash < 0 ? value : value.slice(0, hash);
      const target = url.startsWith(base) ? parseProxyPath(url.slice(base.length)) : null;
      if (!target) return match;
      const fragment = hash < 0 ? "" : value.slice(hash);
      const publicUrl = publicNpmTarballUrl(target.name, target.version).replace(
        "https://registry.npmjs.org/",
        YARN_CLASSIC_REGISTRY,
      );
      return `${open}"${publicUrl}${fragment}"${close}`;
    });
  }
  return content.replace(BERRY_PARAMETERS, (match, open: string, parameters: string, close: string) => {
    const kept = parameters.split("&").filter((parameter) => {
      if (!parameter.startsWith("__archiveUrl=")) return true;
      const url = decode(parameter.slice("__archiveUrl=".length));
      return url === null || !url.startsWith(base);
    });
    return `${open}${kept.length > 0 ? `::${kept.join("&")}` : ""}${close}`;
  });
}
