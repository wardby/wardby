/**
 * `pnpm-lock.yaml` for npm lockfile plans (`POST /registry/npm/-/plan`) and
 * for the rewrite of proxy URLs before collection.
 *
 * Supported: lockfileVersion 9 (pnpm 9+: `packages` holds each
 * name@version's resolution and integrity, `snapshots` each installed
 * instance with its resolved dependencies) and 6 (pnpm 8: `packages` keyed
 * `/name@version`, holding both). An entry is one installed instance (a
 * snapshot, or a v6 package key), so the same name@version with different
 * peers is several entries; plans approve per name@version anyway.
 *
 * pnpm resolves a dependency by the reference the parent's entry records
 * (`ms: 2.1.3`, an alias's `string-width@4.2.3`, both possibly with a
 * `(peer@x)` suffix): `resolve` follows exactly that. `link:` and `file:`
 * references and `directory` resolutions are local and skipped; git and
 * non-registry tarballs are refused. Nothing here decides anything: plan.ts
 * verifies every claim against the registry.
 *
 * Kept free of imports from npm.ts, which imports this module.
 */
import { parseProxyPath, publicNpmTarballUrl } from "./npm-lockfile.js";
import { registryDependencyEdges } from "./npm-plan.js";
import {
  buildResolve,
  entryOf,
  fromRegistry,
  mapOf,
  parseLockfileYaml,
  splitDescriptor,
  stringOf,
  tooLarge,
  yamlEntryLines,
  type Target,
} from "./lockfile-shared.js";
import { RegistryError, type DeclaredDependency, type LockfileEntry, type ParsedLockfile } from "./types.js";

/** Two-space-indented keys a pnpm lockfile may have per entry (a package
 *  and its snapshot, plus slack for importers), for the cheap pre-check. */
const KEY_LINES_PER_ENTRY = 4;

/** `name@1.0.0(peer@2.0.0)(other@3)` without its peer suffix. */
function withoutPeers(reference: string): string {
  const open = reference.indexOf("(");
  return open < 0 ? reference : reference.slice(0, open);
}

/** The string-valued dependencies of a snapshot or package entry. */
function referencesOf(entry: Record<string, unknown>): Map<string, string> {
  const references = new Map<string, string>();
  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const [key, value] of Object.entries(mapOf(entry[field]))) {
      const reference = stringOf(value);
      if (reference !== undefined && !references.has(key)) references.set(key, reference);
    }
  }
  return references;
}

const IMPORTER_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];

/** An importer's declared dependencies (`{ specifier, version }` per name). */
function importerDeclarations(importer: Record<string, unknown>): DeclaredDependency[] {
  const specs: Record<string, string> = {};
  for (const field of IMPORTER_FIELDS) {
    for (const [key, value] of Object.entries(mapOf(importer[field]))) {
      const specifier = stringOf(mapOf(value).specifier) ?? stringOf(value);
      if (specifier !== undefined && !(key in specs)) specs[key] = specifier;
    }
  }
  return registryDependencyEdges(specs);
}

/** The reference (`version`) an importer records for each dependency it
 *  declares, which `resolve` follows like a snapshot's. */
function importerReferences(importer: Record<string, unknown>): Map<string, string> {
  const references = new Map<string, string>();
  for (const field of IMPORTER_FIELDS) {
    for (const [key, value] of Object.entries(mapOf(importer[field]))) {
      const reference = stringOf(mapOf(value).version);
      if (reference !== undefined && !references.has(key)) references.set(key, reference);
    }
  }
  return references;
}

/** The entry for one installed instance: local (null), or registry or
 *  refused by its resolution. */
function classify(path: string, name: string, version: string, resolution: unknown, proxyRegistryUrl: string): Target {
  if (version.startsWith("link:") || version.startsWith("file:")) return null;
  const fields = mapOf(resolution);
  const type = stringOf(fields.type);
  if (type === "directory") return null;
  const tarball = stringOf(fields.tarball);
  if (tarball?.startsWith("file:")) return null;
  const integrity = stringOf(fields.integrity) ?? null;
  const elsewhere = type !== undefined || (tarball !== undefined && !fromRegistry(tarball, proxyRegistryUrl));
  return entryOf(path, name, version, integrity, elsewhere ? "elsewhere" : "registry");
}

export function parsePnpmLockfile(
  body: string,
  options: { maxEntries: number; proxyRegistryUrl: string },
): ParsedLockfile {
  const lines = yamlEntryLines(body);
  if (lines > (options.maxEntries + 1) * KEY_LINES_PER_ENTRY) throw tooLarge(lines, options.maxEntries);
  const document = parseLockfileYaml(body);
  const lockfileVersion = stringOf(document.lockfileVersion) ?? "";
  const major = Number.parseInt(lockfileVersion, 10);
  if (major !== 6 && major !== 9)
    throw new RegistryError(
      400,
      "wardby_lockfile_unsupported",
      `pnpm lockfileVersion ${JSON.stringify(lockfileVersion)} is not supported; regenerate the lockfile with pnpm 8 or later (lockfileVersion 6 or 9)`,
    );
  const packages = mapOf(document.packages);
  const snapshots = mapOf(document.snapshots);
  // v9 lists every installed instance under `snapshots`; v6 has only `packages`.
  const instances = major === 9 && Object.keys(snapshots).length > 0 ? snapshots : packages;
  const count = Object.keys(instances).length;
  if (count > options.maxEntries) throw tooLarge(count, options.maxEntries);

  const entries: LockfileEntry[] = [];
  const byPath = new Map<string, { dependencies: ReadonlyMap<string, string> }>();
  const byKey = new Map<string, Target>();
  for (const [path, raw] of Object.entries(instances)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new RegistryError(400, "wardby_bad_request", `pnpm-lock.yaml entry "${path}" is not a mapping`);
    const instance = raw as Record<string, unknown>;
    let target: Target;
    if (major === 9) {
      const base = withoutPeers(path);
      const { name, range: version } = splitDescriptor(base);
      target = classify(path, name, version, mapOf(packages[base]).resolution, options.proxyRegistryUrl);
    } else if (path.startsWith("/")) {
      const { name, range: version } = splitDescriptor(withoutPeers(path.slice(1)));
      target = classify(path, name, version, instance.resolution, options.proxyRegistryUrl);
    } else {
      // A v6 key without a leading slash is a package from outside the
      // registry (a git host, a URL, a local path); pnpm records its
      // name and version as fields.
      target = classify(
        path,
        stringOf(instance.name) ?? path,
        stringOf(instance.version) ?? "",
        { type: "elsewhere", ...mapOf(instance.resolution) },
        options.proxyRegistryUrl,
      );
    }
    if (target) entries.push(target);
    byPath.set(path, { dependencies: referencesOf(instance) });
    byKey.set(path, target);
  }

  const importers = mapOf(document.importers);
  const importerOf: [string, Record<string, unknown>][] =
    Object.keys(importers).length > 0
      ? Object.entries(importers).map(([path, importer]) => [path, mapOf(importer)])
      : [[".", document]];
  const projects = importerOf.map(([path, importer]) => ({ path, dependencies: importerDeclarations(importer) }));
  // A project resolves what it declares like an instance does (an importer
  // path that is also an instance key keeps the instance's references).
  for (const [path, importer] of importerOf)
    if (!byPath.has(path)) byPath.set(path, { dependencies: importerReferences(importer) });

  const candidates = (key: string, reference: string): string[] => {
    if (reference.startsWith("link:")) return [];
    if (major === 9) {
      // An alias records `name@version`; anything else is this key's version.
      return withoutPeers(reference).indexOf("@", 1) > 0 ? [reference] : [`${key}@${reference}`];
    }
    if (reference.startsWith("/")) return [reference];
    return /^\d/.test(reference) ? [`/${key}@${reference}`] : [reference];
  };
  return { entries, projects, ...buildResolve(byPath, byKey, candidates) };
}

/** Whether `body` is a pnpm lockfile: a top-level `lockfileVersion:` key
 *  (a Berry yarn.lock has `__metadata:` instead, and npm's is JSON). */
export function isPnpmLockfile(body: string): boolean {
  return /^lockfileVersion:/m.test(body);
}

/** A `resolution: {…}` flow mapping on one line of a pnpm lockfile. */
const RESOLUTION = /^(\s+resolution:\s*\{)([^}\n]*)(\}\s*)$/gm;

/**
 * Rewrites what pnpm records of the proxy in a `pnpm-lock.yaml`. pnpm
 * records a package's `tarball` only when the registry's download URL is
 * not the conventional one, which the proxy's own route is not: a proxy
 * `tarball` next to an `integrity` is dropped (exactly what pnpm writes for
 * a package from the public registry), and one without an integrity is
 * rewritten to the public registry URL. Only matched values change.
 */
export function normalizePnpmLockfile(content: string, registryUrl: string): string {
  const base = registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`;
  return content.replace(RESOLUTION, (match, open: string, inner: string, close: string) => {
    const parts = inner.split(",").map((part) => part.trim());
    const tarballAt = parts.findIndex((part) => part.startsWith("tarball:"));
    if (tarballAt < 0) return match;
    const url = parts[tarballAt]
      .slice("tarball:".length)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    const target = url.startsWith(base) ? parseProxyPath(url.slice(base.length)) : null;
    if (!target) return match;
    if (parts.some((part) => part.startsWith("integrity:"))) parts.splice(tarballAt, 1);
    else parts[tarballAt] = `tarball: ${publicNpmTarballUrl(target.name, target.version)}`;
    return `${open}${parts.join(", ")}${close}`;
  });
}
