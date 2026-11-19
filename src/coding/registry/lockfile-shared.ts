/**
 * What the pnpm and yarn lockfile parsers (pnpm-lockfile.ts,
 * yarn-lockfile.ts) share: entry classification, descriptor-based
 * resolution, and bounded YAML reading for the lockfiles pnpm and yarn
 * Berry write (`pnpm-lock.yaml`, a Berry `yarn.lock`). Every scalar is read as a string
 * (the failsafe schema: no type coercion, no custom or language tags), merge
 * keys are off, and any alias or anchor is refused: no lockfile those
 * clients write uses one, and refusing them rules out alias expansion
 * ("billion laughs"). Nothing in a lockfile is ever executed.
 */
import semver from "semver";
import { parseDocument } from "yaml";
import { PACKAGE_NAME } from "./npm-lockfile.js";
import { sourceAllowedFor } from "./private-registry.js";
import { RegistryError, type LockfileEntry, type LockfileParseOptions, type ParsedLockfile } from "./types.js";

/** yarn classic's default registry host, which it writes into `resolved`. */
export const YARN_CLASSIC_REGISTRY = "https://registry.yarnpkg.com/";
/** Where a registry entry may say it was downloaded from (besides the proxy). */
const PUBLIC_REGISTRIES = [YARN_CLASSIC_REGISTRY, "https://registry.npmjs.org/"];
/** Specs and resolutions that are never fetched from the registry. */
const LOCAL_PROTOCOLS = ["file:", "link:", "portal:", "workspace:", "exec:", "patch:"];
export function badRequest(message: string): RegistryError {
  return new RegistryError(400, "wardby_bad_request", message);
}

export function tooLarge(count: number, maxEntries: number): RegistryError {
  return new RegistryError(
    413,
    "wardby_lockfile_too_large",
    `the lockfile has ${count} entries; at most ${maxEntries} are verified (REGISTRY_PLAN_MAX_ENTRIES)`,
  );
}

/** `name@range` split at the `@` that ends the name (a scope's `@` is the
 *  first character). */
export function splitDescriptor(descriptor: string): { name: string; range: string } {
  const at = descriptor.indexOf("@", 1);
  return at < 0 ? { name: descriptor, range: "" } : { name: descriptor.slice(0, at), range: descriptor.slice(at + 1) };
}

export function isLocal(range: string): boolean {
  return LOCAL_PROTOCOLS.some((protocol) => range.startsWith(protocol));
}

/** Whether `url` is where `name` may be downloaded from: a public registry
 *  (or the private one, for a name in its scopes) or the proxy. */
export function fromRegistry(name: string, url: string, options: LockfileParseOptions): boolean {
  return sourceAllowedFor(name, url, { ...options, publicBases: PUBLIC_REGISTRIES });
}

export function entryOf(
  path: string,
  name: string,
  version: string,
  integrity: string | null,
  source: "registry" | "elsewhere",
): LockfileEntry {
  if (!PACKAGE_NAME.test(name) || semver.valid(version) !== version)
    return {
      path,
      name,
      version,
      integrity,
      kind: "unsupported",
      unsupportedReason: "not a registry package name and exact version",
    };
  if (source !== "registry")
    return {
      path,
      name,
      version,
      integrity,
      kind: "unsupported",
      unsupportedReason: "installed from outside the npm registry",
    };
  return { path, name, version, integrity, kind: "registry" };
}

/** What a descriptor names: an entry, or a local package (null). */
export type Target = LockfileEntry | null;

/** The client's resolution rule (`resolve`) and, for each entry, the
 *  dependency keys the lockfile lists for it (`dependencyKeys`): `resolve`
 *  answers only for those keys, which is what lets a parse made in a
 *  worker thread be shipped back as a plain edge table. */
export function buildResolve(
  byPath: ReadonlyMap<string, { dependencies: ReadonlyMap<string, string> }>,
  byDescriptor: ReadonlyMap<string, Target>,
  candidates: (key: string, range: string) => string[],
): Required<Pick<ParsedLockfile, "resolve" | "dependencyKeys">> {
  return {
    resolve: (fromPath, key) => {
      const range = byPath.get(fromPath)?.dependencies.get(key);
      if (range === undefined) return undefined;
      for (const descriptor of candidates(key, range)) {
        const target = byDescriptor.get(descriptor);
        if (target !== undefined) return target ?? undefined;
      }
      return undefined;
    },
    dependencyKeys: (path) => [...(byPath.get(path)?.dependencies.keys() ?? [])],
  };
}

/** A rough upper bound on a YAML lockfile's entries, read without parsing
 *  it: the number of lines that open a two-space-indented mapping key
 *  (each package, snapshot and importer is one). Lets a lockfile far over
 *  the entry bound be refused before the parser builds its whole tree. */
export function yamlEntryLines(body: string): number {
  let count = 0;
  let at = body.indexOf("\n  ");
  while (at >= 0) {
    const next = body[at + 3];
    if (next !== " " && next !== "\n" && next !== "\r" && next !== undefined) count += 1;
    at = body.indexOf("\n  ", at + 3);
  }
  return count;
}

/** The lockfile as plain objects and strings. Throws a 400
 *  `wardby_bad_request` RegistryError for anything that is not a single
 *  valid YAML mapping without aliases. */
export function parseLockfileYaml(body: string): Record<string, unknown> {
  const document = parseDocument(body, {
    schema: "failsafe",
    merge: false,
    // The duplicate-key check is quadratic in a mapping's size (seconds for
    // a large lockfile); a duplicate only means the later value is read,
    // and nothing parsed here is trusted anyway.
    uniqueKeys: false,
    logLevel: "silent",
  });
  if (document.errors.length > 0) throw badRequest("the lockfile is not valid YAML");
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw badRequest("the lockfile uses YAML aliases, which no supported client writes");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw badRequest("the lockfile is not a YAML mapping");
  return value as Record<string, unknown>;
}

/** `value` as a string-keyed object, or an empty one. */
export function mapOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** `value` when it is a string, else undefined. */
export function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
