/**
 * Every lockfile the npm registry route verifies and rewrites: npm's own
 * (package-lock.json, npm-shrinkwrap.json), pnpm's (pnpm-lock.yaml) and
 * yarn's (yarn.lock, classic and Berry). They all install from the same
 * registry, so they share one plan route (`POST /registry/npm/-/plan`),
 * which tells them apart by content, and one set of registry reads.
 *
 * Kept free of imports from npm.ts, which imports this module.
 */
import { normalizeNpmLockfile } from "./npm-lockfile.js";
import { createNpmLockfilePlan, parseNpmLockfile } from "./npm-plan.js";
import { isPnpmLockfile, normalizePnpmLockfile, parsePnpmLockfile } from "./pnpm-lockfile.js";
import {
  RegistryError,
  type LockfileParseOptions,
  type LockfilePlanSupport,
  type ParsedLockfile,
  type PrivateRegistry,
} from "./types.js";
import {
  isYarnBerryLockfile,
  isYarnClassicLockfile,
  normalizeYarnLockfile,
  parseYarnLockfile,
} from "./yarn-lockfile.js";

/** Parses whichever supported lockfile `body` is. */
export function parseNpmClientLockfile(body: string, options: LockfileParseOptions): ParsedLockfile {
  if (body.trimStart().startsWith("{")) return parseNpmLockfile(body, options);
  if (isYarnClassicLockfile(body) || isYarnBerryLockfile(body)) return parseYarnLockfile(body, options);
  if (isPnpmLockfile(body)) return parsePnpmLockfile(body, options);
  throw new RegistryError(
    400,
    "wardby_lockfile_unsupported",
    "not a lockfile this registry verifies: send a package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml or yarn.lock",
  );
}

export function createNpmClientLockfilePlan(privateRegistry?: PrivateRegistry): LockfilePlanSupport {
  return {
    ...createNpmLockfilePlan(privateRegistry),
    parse: parseNpmClientLockfile,
    // npm's JSON parses in milliseconds on the event loop; pnpm's and yarn's
    // formats go to a worker thread (registry/lockfile-parse.ts).
    parsesOffThread: (body) => !body.trimStart().startsWith("{"),
  };
}

export const npmClientLockfilePlan: LockfilePlanSupport = createNpmClientLockfilePlan();

const LOCKFILE_NAMES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"] as const;

export function createNpmClientLockfiles(privateRegistry?: PrivateRegistry) {
  return {
    names: LOCKFILE_NAMES,
    normalize(content: string, registryUrl: string, name: string): string {
      if (name === "pnpm-lock.yaml") return normalizePnpmLockfile(content, registryUrl, privateRegistry);
      if (name === "yarn.lock") return normalizeYarnLockfile(content, registryUrl, privateRegistry);
      return normalizeNpmLockfile(content, registryUrl, privateRegistry);
    },
  };
}

export const npmClientLockfiles = createNpmClientLockfiles();
