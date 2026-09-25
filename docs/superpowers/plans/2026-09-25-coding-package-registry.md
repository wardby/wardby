# Coding Package Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A coding agent can run `npm install` and `pip install` inside its sandbox, through the coding proxy, limited to a per-agent allowlist and its dependency graph, with install scripts off, a minimum release age, an OSV audit, and every package recorded and shown to the reviewer.

**Architecture:** A shared registry core in the coding proxy (auth, allowance, filtering, audit, streaming, integrity, limits, records) plus one adapter per ecosystem (npm, PyPI) implementing a common `RegistryAdapter` interface. The worker driver points npm and pip at `http://wardby-proxy:8787/registry/<ecosystem>/` using a registry-only token derived from the run capability. The allowlist lives on the coding profile behind a new `packages:approve` scope and is snapshotted onto the run.

**Tech Stack:** TypeScript (Node 24, ESM), Zod, Prisma 6, Vitest, `semver`, `@renovatebot/pep440`, `fflate`.

**Spec:** `docs/superpowers/specs/2026-09-25-coding-package-registry-design.md`. **Depends on:** `docs/superpowers/plans/2026-09-25-coding-collect-exclusions.md` (Plan A) being merged first: installs land in `node_modules`, `.venv` and `.cache`, which must already be excluded from collection.

## Global Constraints

- Scope name: `packages:approve`. Changing `packageAllowlist` or `packagePolicy` requires `packages:approve` **or** `agents:admin`; every other profile field keeps its current scope.
- Minimum release age: default **3** days; profile override integer **0–30**; a version with no timestamp is treated as too new.
- Audit: withhold versions with an OSV advisory of severity **HIGH** or **CRITICAL**; report others. OSV unreachable → `503 wardby_audit_unavailable` unless `REGISTRY_AUDIT_FAIL_OPEN=true`.
- Upstream hosts, and no others: `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `api.osv.dev`.
- Per-run limits (operator env, defaults): one file ≤ **200 MiB** (`REGISTRY_MAX_FILE_MB`), total ≤ **2 GiB** (`REGISTRY_MAX_TOTAL_MB`), ≤ **5,000** files (`REGISTRY_MAX_FILES`), idle timeout **120 s** per download (`REGISTRY_IDLE_TIMEOUT_MS`).
- Metadata cache TTL: **5 minutes**; OSV cache TTL: **1 hour**.
- Error codes: `wardby_package_not_allowed` (403), `wardby_file_not_allowed` (403), `wardby_version_filtered` (404), `wardby_package_not_found` (404), `wardby_package_too_large` (413), `wardby_package_limit` (429), `wardby_audit_unavailable` (503), `invalid_capability` (401).
- The agent never receives the model-API run capability: npm and pip get only the derived registry token, written only under `/workspace/.cache`.
- PyPI serves wheels only. npm install scripts are disabled by configuration only (documented limit).
- Every schema change ships with its hand-written migration and a clean drift check (this worktree's `CLAUDE.md`). Never `prisma db push`.
- Commits end with the session's attribution lines; work on the plan's branch in its worktree, never on `main`.

## Spec amendments made by this plan

Record these in the spec in Task 12:

1. **Registry token.** npm and pip authenticate with `rrg_` + base64url(sha256(`"wardby-registry\0"` + capability)), derived by the driver. The proxy stores its hash on `CodingProxySession.registryTokenHash` and accepts it only on `/registry/` routes; the model routes accept only the original capability. The agent's shell never receives the model capability.
2. **`allowedEgress` removal is two-phase.** This plan removes every code path that reads or writes it (Task 1) but keeps the columns; dropping them is Task 14, released only after this plan's release is fully rolled out, so pods from the previous release never query a dropped column.
3. **Always configured.** The driver configures npm and pip for every coding run; an agent with no allowlist for an ecosystem gets `403 wardby_package_not_allowed` naming the missing allowlist, so no worker-protocol change is needed.
4. **`resolveFileMetadata`.** The adapter interface gains an optional `resolveFileMetadata(route, meta)` for PEP 658 metadata files.

---

## File Structure

| File                                                                                                                                                 | Responsibility                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `src/coding/registry/types.ts`                                                                                                                       | `RegistryAdapter` and supporting types; `RegistryError`. |
| `src/coding/registry/allowlist.ts`                                                                                                                   | Allowlist and policy schemas, parsing, root matching.    |
| `src/coding/registry/npm.ts`                                                                                                                         | npm adapter.                                             |
| `src/coding/registry/pypi.ts`                                                                                                                        | PyPI adapter.                                            |
| `src/coding/registry/adapters.ts`                                                                                                                    | `REGISTRY_ADAPTERS` map.                                 |
| `src/coding/registry/token.ts`                                                                                                                       | `deriveRegistryToken`.                                   |
| `src/coding/registry/worker-config.ts`                                                                                                               | Environment and files the drivers apply.                 |
| `src/providers/coding-proxy/registry/audit.ts`                                                                                                       | OSV client with cache and fail-closed behavior.          |
| `src/providers/coding-proxy/registry/store.ts`                                                                                                       | `RegistryStore` interface and in-memory implementation.  |
| `src/providers/coding-proxy/registry/prisma-store.ts`                                                                                                | Prisma implementation.                                   |
| `src/providers/coding-proxy/registry/service.ts`                                                                                                     | Registry core.                                           |
| `src/providers/coding-proxy/server.ts`, `runtime.ts`, `proxy.ts`, `types.ts`, `prisma-ledger.ts`, `memory-ledger.ts`                                 | Routes, wiring, registry token hash on sessions.         |
| `src/coding/profile.ts`, `src/mcp/tools/agents.ts`, `src/mcp/auth/resource-server.ts`, `src/core/dispatch.ts`, `src/providers/executor/container.ts` | Fields, scope, snapshot, `allowedEgress` removal.        |
| `src/coding-worker/driver.ts`, `src/claude-coding-worker/driver.ts`                                                                                  | Apply worker config.                                     |
| `src/mcp/tools/runs.ts`, `src/providers/vcs/github.ts`, `src/providers/vcs/types.ts`, `src/providers/vcs/git.ts`                                     | `get_run` packages and the PR section.                   |
| `prisma/schema.prisma` + migration `20260925020000_coding_package_registry`                                                                          | Columns and tables.                                      |
| `deploy/kind-coding/manifests/base/proxy.yaml`                                                                                                       | Proxy memory 512 Mi.                                     |
| `docs/*`                                                                                                                                             | Documentation.                                           |

---

### Task 1: Stop reading and writing `allowedEgress`

**Files:**

- Modify: `src/coding/profile.ts` (remove `MAX_ALLOWED_EGRESS_HOSTS`, `egressHostSchema`, the `allowedEgress` field and both schema entries)
- Modify: `src/mcp/tools/agents.ts` (`profileJsonSchema`, `storedProfile`)
- Modify: `src/core/dispatch.ts:213` (remove the `allowedEgress:` line)
- Modify: `src/providers/executor/container.ts` (remove `allowedEgress` from the snapshot type, row mapping, and the preflight `CodingProfileSchema.parse` call)
- Modify: `prisma/schema.prisma` (keep both `allowedEgress Json` columns but give them `@default("[]")` and a `/// Unused; dropped after rollout (Task 14).` doc comment)
- Create: `prisma/migrations/20260925015000_allowed_egress_default/migration.sql`
- Test: `src/coding/profile.test.ts`, `src/core/dispatch.test.ts`, `src/mcp/tools/agents.test.ts`, `src/providers/executor/container.test.ts`

**Interfaces:**

- Produces: `CodingProfile` without `allowedEgress`; a profile input that includes `allowedEgress` is rejected by the strict schema.

- [ ] **Step 1: Write the failing tests**

In `src/coding/profile.test.ts`:

- Remove `allowedEgress: [],` from the expected defaults object.
- Replace the four `allowedEgress` rows in the rejection `it.each` table with one row: `{ repository: "openai/example", allowedEgress: [] },` (now rejected because the strict schema no longer knows the key).

In `src/core/dispatch.test.ts`, add:

```ts
it("no longer writes allowedEgress onto the coding run", async () => {
  const agent = {
    ...nativeAgent(),
    kind: "coding",
    budgetUsd: 1.25,
    codingProfile: {
      provider: "codex",
      repository: "openai/wardby",
      baseRef: "main",
      defaultTask: "Fix the failing tests",
      timeoutSec: 900,
      protectedPaths: [],
    },
  };
  const state = fakeDb(agent);
  await dispatchRun({ db: state.db, executor: { async start() {}, async stop() {} }, agentId: agent.id });
  expect(state.codingRuns[0]).not.toHaveProperty("allowedEgress");
});
```

Remove `allowedEgress: [],` from every other `codingProfile` literal in `dispatch.test.ts` and `container.test.ts` fixtures (search `allowedEgress`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/coding/profile.test.ts src/core/dispatch.test.ts`
Expected: FAIL — the schema still accepts and defaults `allowedEgress`; dispatch still writes it.

- [ ] **Step 3: Remove the field from code**

- `src/coding/profile.ts`: delete `MAX_ALLOWED_EGRESS_HOSTS`, `MAX_HOST_BYTES` if now unused, `egressHostSchema`, the `allowedEgress` entry in `codingProfileFields`, `CodingProfileSchema`, and `CodingProfilePatchSchema`, and the `isIP` import if now unused.
- `src/mcp/tools/agents.ts`: delete the `allowedEgress` property from `profileJsonSchema` and the `allowedEgress:` line from `storedProfile`.
- `src/core/dispatch.ts`: delete `allowedEgress: agent.codingProfile.allowedEgress as Prisma.InputJsonValue,`.
- `src/providers/executor/container.ts`: delete `allowedEgress: unknown;`, `allowedEgress: row.codingRun.allowedEgress,`, and the `allowedEgress: run.allowedEgress,` line in the preflight parse.

- [ ] **Step 4: Default the columns so inserts without them succeed**

In `prisma/schema.prisma`, change both `allowedEgress Json` lines to:

```prisma
  /// Unused; dropped after rollout (see the package-registry plan, Task 14).
  allowedEgress            Json     @default("[]")
```

Create `prisma/migrations/20260925015000_allowed_egress_default/migration.sql`:

```sql
-- allowedEgress was stored but never enforced and is no longer written. A default
-- lets new rows omit it; the columns are dropped in a later release.

-- AlterTable
ALTER TABLE "CodingAgentProfile" ALTER COLUMN "allowedEgress" SET DEFAULT '[]';

-- AlterTable
ALTER TABLE "CodingRun" ALTER COLUMN "allowedEgress" SET DEFAULT '[]';
```

Run: `npm run prisma:generate`

- [ ] **Step 5: Run the tests, drift check, and README correction**

Run: `npx vitest run src/coding src/core src/mcp/tools src/providers/executor`
Expected: PASS.

Run the drift check from `CLAUDE.md`; expected `-- This is an empty migration.`

In `README.md`, change "with resource limits, protected paths, bounded output, and reviewed network access." to "with resource limits, protected paths, bounded output, and no network access except the coding proxy."

- [ ] **Step 6: Commit**

```bash
git add -A src prisma README.md
git commit -m "refactor(coding): stop using the unenforced allowedEgress field"
```

---

### Task 2: Registry types and allowlist model

**Files:**

- Create: `src/coding/registry/types.ts`, `src/coding/registry/allowlist.ts`
- Test: `src/coding/registry/allowlist.test.ts`

**Interfaces:**

- Produces (types.ts): exactly the spec's interface, plus `resolveFileMetadata?` and `RegistryError`:

```ts
export type EcosystemId = string;
export interface AllowlistEntry {
  name: string;
  wildcard: boolean;
  range?: string;
}
export class AllowlistEntryError extends Error {}
export class RegistryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface Integrity {
  algorithm: "sha512" | "sha384" | "sha256" | "sha1";
  hex: string;
}
export interface FileRef {
  filename: string;
  version: string;
  upstreamUrl: string;
  integrity: Integrity | null;
  sizeBytes: number | null;
  allowed: boolean;
}
export interface VersionInfo {
  version: string;
  publishedAt: Date | null;
  dependencies: readonly string[];
  files: readonly FileRef[];
}
export interface PackageMetadata {
  name: string;
  versions: ReadonlyMap<string, VersionInfo>;
  raw: unknown;
}
export interface MetadataRoute {
  kind: "metadata";
  name: string;
}
export interface DownloadRoute {
  kind: "download";
  name: string;
  version: string;
  filename: string;
}
export interface FileMetadataRoute {
  kind: "file-metadata";
  name: string;
  filename: string;
}
export type RegistryRoute = MetadataRoute | DownloadRoute | FileMetadataRoute;
export interface RenderedDocument {
  contentType: string;
  body: string;
}
export type UpstreamFetch = (
  url: string,
  init?: { method?: "GET" | "POST"; body?: string; accept?: string; signal?: AbortSignal },
) => Promise<Response>;
export interface WorkerConfigInput {
  registryUrl: string;
  token: string;
  cacheDir: string;
}
export interface WorkerConfig {
  env: Readonly<Record<string, string>>;
  files: readonly { path: string; content: string; mode: number }[];
}
export interface RegistryAdapter {
  /* members exactly as in the spec §5, with `token` in WorkerConfigInput, plus: */
  resolveFileMetadata?(route: FileMetadataRoute, meta: PackageMetadata): FileRef | null;
}
```

- Produces (allowlist.ts):

```ts
export type PackageAllowlist = Readonly<Record<string, readonly string[]>>;
export interface PackagePolicy {
  minReleaseAgeDays: number;
}
export const DEFAULT_MIN_RELEASE_AGE_DAYS = 3;
export function resolvePolicy(value: unknown): PackagePolicy;
export function parseAllowlist(
  allowlist: PackageAllowlist,
  adapters: ReadonlyMap<string, RegistryAdapter>,
): Map<string, AllowlistEntry[]>;
export function matchRoot(entries: readonly AllowlistEntry[], normalizedName: string): AllowlistEntry | undefined;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/coding/registry/allowlist.test.ts
import { describe, expect, it } from "vitest";
import { matchRoot, resolvePolicy } from "./allowlist.js";

describe("matchRoot", () => {
  const entries = [
    { name: "react", wildcard: false, range: "^19" },
    { name: "@heroui/", wildcard: true },
  ];
  it("matches exact names and scope wildcards", () => {
    expect(matchRoot(entries, "react")).toEqual(entries[0]);
    expect(matchRoot(entries, "@heroui/react")).toEqual(entries[1]);
    expect(matchRoot(entries, "@heroui")).toBeUndefined();
    expect(matchRoot(entries, "react-dom")).toBeUndefined();
  });
});

describe("resolvePolicy", () => {
  it("defaults to three days and bounds overrides", () => {
    expect(resolvePolicy(undefined)).toEqual({ minReleaseAgeDays: 3 });
    expect(resolvePolicy({ minReleaseAgeDays: 0 })).toEqual({ minReleaseAgeDays: 0 });
    expect(() => resolvePolicy({ minReleaseAgeDays: 31 })).toThrow();
    expect(() => resolvePolicy({ minReleaseAgeDays: 1.5 })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/coding/registry/allowlist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `types.ts` and `allowlist.ts`**

Write `types.ts` with the declarations in **Interfaces** above, completing `RegistryAdapter` with every member from spec §5 (`id`, `osvEcosystem`, `upstreamHosts`, `collectExclude`, `parseAllowlistEntry`, `normalizeName`, `satisfies`, `route`, `fetchMetadata`, `renderMetadata`, `resolveDownload`, `dependenciesFromFile?`, `workerConfig`) plus `resolveFileMetadata?`.

```ts
// src/coding/registry/allowlist.ts
import { z } from "zod";
import type { AllowlistEntry, RegistryAdapter } from "./types.js";

export type PackageAllowlist = Readonly<Record<string, readonly string[]>>;
export interface PackagePolicy {
  minReleaseAgeDays: number;
}
export const DEFAULT_MIN_RELEASE_AGE_DAYS = 3;

const PolicySchema = z
  .object({ minReleaseAgeDays: z.number().int().min(0).max(30).default(DEFAULT_MIN_RELEASE_AGE_DAYS) })
  .strict();

export function resolvePolicy(value: unknown): PackagePolicy {
  return PolicySchema.parse(value ?? {});
}

export function parseAllowlist(
  allowlist: PackageAllowlist,
  adapters: ReadonlyMap<string, RegistryAdapter>,
): Map<string, AllowlistEntry[]> {
  const parsed = new Map<string, AllowlistEntry[]>();
  for (const [ecosystem, entries] of Object.entries(allowlist)) {
    const adapter = adapters.get(ecosystem);
    if (!adapter) throw new Error(`unknown package ecosystem "${ecosystem}"`);
    parsed.set(
      ecosystem,
      entries.map((entry) => adapter.parseAllowlistEntry(entry)),
    );
  }
  return parsed;
}

export function matchRoot(entries: readonly AllowlistEntry[], normalizedName: string): AllowlistEntry | undefined {
  return entries.find((entry) =>
    entry.wildcard
      ? normalizedName.startsWith(entry.name) && normalizedName.length > entry.name.length
      : entry.name === normalizedName,
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/coding/registry/allowlist.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/coding/registry
git commit -m "feat(registry): adapter interface and allowlist model"
```

---

### Task 3: npm adapter

**Files:**

- Modify: `package.json` (add `semver` to dependencies, `@types/semver` to devDependencies; run `npm install`)
- Create: `src/coding/registry/npm.ts`
- Create: `src/coding/registry/fixtures/npm-left-pad.json` (a trimmed real packument: 3 versions, `time`, `dist.tarball`, `dist.integrity`, one with `dependencies`)
- Test: `src/coding/registry/npm.test.ts`

**Interfaces:**

- Consumes: Task 2 types.
- Produces: `export const npmAdapter: RegistryAdapter` with `id: "npm"`, `osvEcosystem: "npm"`, `upstreamHosts: ["registry.npmjs.org"]`, `collectExclude: ["node_modules"]`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/coding/registry/npm.test.ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { npmAdapter } from "./npm.js";

const fixture = async () =>
  JSON.parse(await readFile(new URL("./fixtures/npm-left-pad.json", import.meta.url), "utf8"));
const upstream = async (body: unknown) => async () => Response.json(body);

describe("npmAdapter allowlist syntax", () => {
  it.each([
    ["react", { name: "react", wildcard: false }],
    ["react@^19", { name: "react", wildcard: false, range: "^19" }],
    ["@heroui/react@^3", { name: "@heroui/react", wildcard: false, range: "^3" }],
    ["@HeroUI/*", { name: "@heroui/", wildcard: true }],
  ])("parses %s", (raw, expected) => {
    expect(npmAdapter.parseAllowlistEntry(raw)).toEqual(expected);
  });
  it.each(["", "react@not-a-range", "../evil", "a b"])("rejects %j", (raw) => {
    expect(() => npmAdapter.parseAllowlistEntry(raw)).toThrow();
  });
});

describe("npmAdapter protocol", () => {
  it("routes packuments, scoped packuments and tarballs", () => {
    expect(npmAdapter.route("GET", "left-pad", new Headers())).toEqual({ kind: "metadata", name: "left-pad" });
    expect(npmAdapter.route("GET", "@heroui%2freact", new Headers())).toEqual({
      kind: "metadata",
      name: "@heroui/react",
    });
    expect(npmAdapter.route("GET", "-/tarball/%40heroui%2Freact/3.2.6", new Headers())).toEqual({
      kind: "download",
      name: "@heroui/react",
      version: "3.2.6",
      filename: "3.2.6.tgz",
    });
    expect(npmAdapter.route("POST", "left-pad", new Headers())).toBeNull();
  });

  it("parses versions, dates, dependencies and integrity", async () => {
    const meta = await npmAdapter.fetchMetadata("left-pad", await upstream(await fixture()));
    const [first] = [...meta.versions.values()];
    expect(first.publishedAt).toBeInstanceOf(Date);
    expect(first.files[0].integrity?.algorithm).toBe("sha512");
    expect(first.files[0].upstreamUrl.startsWith("https://registry.npmjs.org/")).toBe(true);
  });

  it("renders only kept versions with tarballs rewritten to the proxy and latest repointed", async () => {
    const meta = await npmAdapter.fetchMetadata("left-pad", await upstream(await fixture()));
    const versions = [...meta.versions.keys()];
    const keep = new Set([versions[0]]);
    const doc = JSON.parse(npmAdapter.renderMetadata(meta, keep, "http://wardby-proxy:8787/registry/npm/").body);
    expect(Object.keys(doc.versions)).toEqual([versions[0]]);
    expect(doc.versions[versions[0]].dist.tarball).toBe(
      `http://wardby-proxy:8787/registry/npm/-/tarball/left-pad/${versions[0]}`,
    );
    expect(doc["dist-tags"].latest).toBe(versions[0]);
  });

  it("writes an npmrc with the registry token under the cache dir only", () => {
    const config = npmAdapter.workerConfig({
      registryUrl: "http://wardby-proxy:8787/registry/npm/",
      token: "rrg_example",
      cacheDir: "/workspace/.cache/npm",
    });
    expect(config.env.npm_config_ignore_scripts).toBe("true");
    expect(config.env.npm_config_userconfig).toBe("/workspace/.cache/npm/npmrc");
    expect(config.files).toEqual([
      {
        path: "/workspace/.cache/npm/npmrc",
        content: "//wardby-proxy:8787/registry/npm/:_authToken=rrg_example\n",
        mode: 0o600,
      },
    ]);
  });
});
```

Create the fixture by running `curl -s https://registry.npmjs.org/left-pad | node -e '...'` to keep only `name`, `dist-tags`, `time` (for kept versions), and three `versions` entries (keep `dist`, `dependencies`). Commit the trimmed JSON.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/coding/registry/npm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter**

```ts
// src/coding/registry/npm.ts
import semver from "semver";
import {
  AllowlistEntryError,
  RegistryError,
  type AllowlistEntry,
  type DownloadRoute,
  type FileRef,
  type Integrity,
  type PackageMetadata,
  type RegistryAdapter,
  type RegistryRoute,
  type VersionInfo,
} from "./types.js";

const NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const SCOPE_WILDCARD = /^(@[a-z0-9-~][a-z0-9-._~]*)\/\*$/;
const UPSTREAM = "https://registry.npmjs.org/";

interface Packument {
  name: string;
  "dist-tags"?: Record<string, string>;
  time?: Record<string, string>;
  versions: Record<
    string,
    {
      dist: { tarball: string; integrity?: string; shasum?: string };
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    }
  >;
}

function integrityOf(dist: { integrity?: string; shasum?: string }): Integrity | null {
  const sri = dist.integrity?.match(/^(sha512|sha384|sha256)-([A-Za-z0-9+/=]+)$/);
  if (sri) return { algorithm: sri[1] as Integrity["algorithm"], hex: Buffer.from(sri[2], "base64").toString("hex") };
  if (dist.shasum && /^[a-f0-9]{40}$/.test(dist.shasum)) return { algorithm: "sha1", hex: dist.shasum };
  return null;
}

function validName(name: string): string {
  const normalized = name.toLowerCase();
  if (!NAME.test(normalized)) throw new AllowlistEntryError(`"${name}" is not a valid npm package name`);
  return normalized;
}

export const npmAdapter: RegistryAdapter = {
  id: "npm",
  osvEcosystem: "npm",
  upstreamHosts: ["registry.npmjs.org"],
  collectExclude: ["node_modules"],

  parseAllowlistEntry(raw: string): AllowlistEntry {
    const value = raw.trim();
    const scope = value.toLowerCase().match(SCOPE_WILDCARD);
    if (scope) return { name: `${scope[1]}/`, wildcard: true };
    const at = value.indexOf("@", 1);
    const name = validName(at > 0 ? value.slice(0, at) : value);
    if (at < 0) return { name, wildcard: false };
    const range = value.slice(at + 1);
    if (!semver.validRange(range)) throw new AllowlistEntryError(`"${range}" is not a valid npm version range`);
    return { name, wildcard: false, range };
  },

  normalizeName: (name) => name.toLowerCase(),

  satisfies: (version, range) => semver.satisfies(version, range),

  route(method, subpath): RegistryRoute | null {
    if (method !== "GET" && method !== "HEAD") return null;
    const tarball = subpath.match(/^-\/tarball\/([^/]+)\/([^/]+)$/);
    try {
      if (tarball) {
        const name = decodeURIComponent(tarball[1]).toLowerCase();
        const version = decodeURIComponent(tarball[2]);
        if (!NAME.test(name) || !semver.valid(version)) return null;
        return { kind: "download", name, version, filename: `${version}.tgz` };
      }
      const name = decodeURIComponent(subpath).toLowerCase();
      return NAME.test(name) ? { kind: "metadata", name } : null;
    } catch {
      return null;
    }
  },

  async fetchMetadata(name, upstream): Promise<PackageMetadata> {
    const response = await upstream(`${UPSTREAM}${name.replace("/", "%2f")}`, { accept: "application/json" });
    if (response.status === 404)
      throw new RegistryError(404, "wardby_package_not_found", `npm has no package "${name}"`);
    if (!response.ok) throw new RegistryError(502, "wardby_upstream_error", `npm returned ${response.status}`);
    const doc = (await response.json()) as Packument;
    const versions = new Map<string, VersionInfo>();
    for (const [version, info] of Object.entries(doc.versions ?? {})) {
      const published = doc.time?.[version];
      const dependencies = [
        ...new Set(
          [info.dependencies, info.optionalDependencies, info.peerDependencies].flatMap((deps) =>
            Object.keys(deps ?? {}).map((dep) => dep.toLowerCase()),
          ),
        ),
      ];
      const file: FileRef = {
        filename: `${version}.tgz`,
        version,
        upstreamUrl: info.dist.tarball,
        integrity: integrityOf(info.dist),
        sizeBytes: null,
        allowed: true,
      };
      versions.set(version, {
        version,
        publishedAt: published ? new Date(published) : null,
        dependencies,
        files: [file],
      });
    }
    return { name: doc.name.toLowerCase(), versions, raw: doc };
  },

  renderMetadata(meta, keep, proxyBase) {
    const raw = meta.raw as Packument;
    const versions: Packument["versions"] = {};
    for (const version of keep) {
      const info = raw.versions[version];
      if (!info) continue;
      versions[version] = {
        ...info,
        dist: { ...info.dist, tarball: `${proxyBase}-/tarball/${encodeURIComponent(meta.name)}/${version}` },
      };
    }
    const kept = Object.keys(versions);
    const tags = Object.fromEntries(
      Object.entries(raw["dist-tags"] ?? {}).filter(([, version]) => kept.includes(version)),
    );
    if (!tags.latest && kept.length > 0) tags.latest = semver.maxSatisfying(kept, "*") ?? kept[kept.length - 1];
    const time = Object.fromEntries(Object.entries(raw.time ?? {}).filter(([key]) => kept.includes(key)));
    return {
      contentType: "application/json",
      body: JSON.stringify({ name: raw.name, "dist-tags": tags, time, versions }),
    };
  },

  resolveDownload(route: DownloadRoute, meta) {
    return meta.versions.get(route.version)?.files.find((file) => file.filename === route.filename) ?? null;
  },

  workerConfig({ registryUrl, token, cacheDir }) {
    const npmrc = `${cacheDir}/npmrc`;
    return {
      env: {
        npm_config_registry: registryUrl,
        npm_config_userconfig: npmrc,
        npm_config_ignore_scripts: "true",
        npm_config_cache: cacheDir,
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
      files: [{ path: npmrc, content: `${registryUrl.replace(/^https?:/, "")}:_authToken=${token}\n`, mode: 0o600 }],
    };
  },
};
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/coding/registry/npm.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/coding/registry/npm.ts src/coding/registry/npm.test.ts src/coding/registry/fixtures/npm-left-pad.json
git commit -m "feat(registry): npm adapter"
```

---

### Task 4: PyPI adapter

**Files:**

- Modify: `package.json` (add `@renovatebot/pep440` and `fflate` to dependencies; `npm install`)
- Create: `src/coding/registry/pypi.ts`
- Create: `src/coding/registry/fixtures/pypi-flask.json` (a trimmed PEP 691 response for `flask`: two versions, each with one wheel and one sdist, `upload-time`, `hashes.sha256`, `core-metadata`)
- Create: `src/coding/registry/fixtures/flask.METADATA` (a real wheel `METADATA` file with `Requires-Dist` lines, including one with an `extra ==` marker)
- Test: `src/coding/registry/pypi.test.ts`

**Interfaces:**

- Produces: `export const pypiAdapter: RegistryAdapter` with `id: "pypi"`, `osvEcosystem: "PyPI"`, `upstreamHosts: ["pypi.org", "files.pythonhosted.org"]`, `collectExclude: [".venv", "venv", "__pycache__"]`, implementing `resolveFileMetadata` and `dependenciesFromFile`; `export function requiresDist(metadataText: string): string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/coding/registry/pypi.test.ts
import { readFile } from "node:fs/promises";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { pypiAdapter, requiresDist } from "./pypi.js";

const json = async () => JSON.parse(await readFile(new URL("./fixtures/pypi-flask.json", import.meta.url), "utf8"));
const metadataText = () => readFile(new URL("./fixtures/flask.METADATA", import.meta.url), "utf8");

describe("pypiAdapter allowlist syntax", () => {
  it.each([
    ["flask", { name: "flask", wildcard: false }],
    ["Flask>=3", { name: "flask", wildcard: false, range: ">=3" }],
    ["zope.interface ~=6.0", { name: "zope-interface", wildcard: false, range: "~=6.0" }],
  ])("parses %s", (raw, expected) => {
    expect(pypiAdapter.parseAllowlistEntry(raw)).toEqual(expected);
  });
  it.each(["", "flask>>3", "@scope/*"])("rejects %j", (raw) => {
    expect(() => pypiAdapter.parseAllowlistEntry(raw)).toThrow();
  });
});

describe("pypiAdapter protocol", () => {
  it("routes the simple index, files, and metadata files", () => {
    expect(pypiAdapter.route("GET", "simple/Flask/", new Headers())).toEqual({ kind: "metadata", name: "flask" });
    expect(pypiAdapter.route("GET", "files/flask/flask-3.0.0-py3-none-any.whl", new Headers())).toMatchObject({
      kind: "download",
      version: "3.0.0",
    });
    expect(pypiAdapter.route("GET", "files/flask/flask-3.0.0-py3-none-any.whl.metadata", new Headers())).toEqual({
      kind: "file-metadata",
      name: "flask",
      filename: "flask-3.0.0-py3-none-any.whl",
    });
  });

  it("keeps wheels, refuses sdists, and rewrites file URLs", async () => {
    const meta = await pypiAdapter.fetchMetadata("flask", async () => Response.json(await json()));
    const files = [...meta.versions.values()].flatMap((version) => version.files);
    expect(files.filter((file) => file.filename.endsWith(".tar.gz")).every((file) => !file.allowed)).toBe(true);
    const keep = new Set(meta.versions.keys());
    const doc = JSON.parse(pypiAdapter.renderMetadata(meta, keep, "http://wardby-proxy:8787/registry/pypi/").body);
    expect(doc.files.every((file: { filename: string }) => file.filename.endsWith(".whl"))).toBe(true);
    expect(doc.files[0].url.startsWith("http://wardby-proxy:8787/registry/pypi/files/flask/")).toBe(true);
  });

  it("reads Requires-Dist names and skips extras", async () => {
    const names = requiresDist(await metadataText());
    expect(names).toContain("werkzeug");
    expect(names).not.toContain("asgiref"); // only under extra == "async"
  });

  it("reads dependencies from a wheel's dist-info METADATA", async () => {
    const wheel = zipSync({ "flask-3.0.0.dist-info/METADATA": strToU8(await metadataText()) });
    const names = await pypiAdapter.dependenciesFromFile!(
      { kind: "download", name: "flask", version: "3.0.0", filename: "flask-3.0.0-py3-none-any.whl" },
      wheel,
    );
    expect(names).toContain("werkzeug");
  });

  it("configures pip for wheels only with the registry token", () => {
    const config = pypiAdapter.workerConfig({
      registryUrl: "http://wardby-proxy:8787/registry/pypi/",
      token: "rrg_example",
      cacheDir: "/workspace/.cache/pypi",
    });
    expect(config.env.PIP_INDEX_URL).toBe("http://wardby:rrg_example@wardby-proxy:8787/registry/pypi/simple/");
    expect(config.env.PIP_ONLY_BINARY).toBe(":all:");
    expect(config.files).toEqual([]);
  });
});
```

Create the fixtures from `curl -s -H 'Accept: application/vnd.pypi.simple.v1+json' https://pypi.org/simple/flask/` (trim to two versions) and from a Flask wheel's `METADATA`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/coding/registry/pypi.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter**

```ts
// src/coding/registry/pypi.ts
import { satisfies as pepSatisfies, validRange } from "@renovatebot/pep440";
import { unzipSync, strFromU8 } from "fflate";
import {
  AllowlistEntryError,
  RegistryError,
  type FileRef,
  type PackageMetadata,
  type RegistryAdapter,
  type RegistryRoute,
  type VersionInfo,
} from "./types.js";

const UPSTREAM = "https://pypi.org/simple/";
const SIMPLE_JSON = "application/vnd.pypi.simple.v1+json";
const ENTRY = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(.*)$/;
const WHEEL_METADATA_LIMIT = 64 * 1024 * 1024;

interface SimpleFile {
  filename: string;
  url: string;
  hashes?: { sha256?: string };
  "upload-time"?: string;
  size?: number;
  "core-metadata"?: boolean | { sha256?: string };
  "dist-info-metadata"?: boolean | { sha256?: string };
  "requires-python"?: string;
  yanked?: boolean | string;
}
interface SimpleIndex {
  name: string;
  files: SimpleFile[];
}

export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Version from a wheel ("name-1.0-py3-none-any.whl") or sdist ("name-1.0.tar.gz") filename. */
function versionOf(filename: string): string | null {
  if (filename.endsWith(".whl")) return filename.split("-")[1] ?? null;
  const sdist = filename.match(/^.+?-(\d[^-]*)\.(?:tar\.gz|zip)$/);
  return sdist ? sdist[1] : null;
}

export function requiresDist(metadataText: string): string[] {
  const names = new Set<string>();
  for (const line of metadataText.split(/\r?\n/)) {
    if (!line.startsWith("Requires-Dist:")) continue;
    const value = line.slice("Requires-Dist:".length).trim();
    if (/;\s*.*\bextra\s*==/.test(value)) continue;
    const name = value.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (name) names.add(normalizePypiName(name[1]));
  }
  return [...names];
}

export const pypiAdapter: RegistryAdapter = {
  id: "pypi",
  osvEcosystem: "PyPI",
  upstreamHosts: ["pypi.org", "files.pythonhosted.org"],
  collectExclude: [".venv", "venv", "__pycache__"],

  parseAllowlistEntry(raw) {
    const match = raw.trim().match(ENTRY);
    if (!match) throw new AllowlistEntryError(`"${raw}" is not a valid Python package entry`);
    const name = normalizePypiName(match[1]);
    const range = match[2].trim();
    if (!range) return { name, wildcard: false };
    if (!validRange(range)) throw new AllowlistEntryError(`"${range}" is not a valid PEP 440 specifier`);
    return { name, wildcard: false, range };
  },

  normalizeName: normalizePypiName,

  satisfies: (version, range) => pepSatisfies(version, range),

  route(method, subpath): RegistryRoute | null {
    if (method !== "GET" && method !== "HEAD") return null;
    const simple = subpath.match(/^simple\/([^/]+)\/?$/);
    if (simple) return { kind: "metadata", name: normalizePypiName(decodeURIComponent(simple[1])) };
    const file = subpath.match(/^files\/([^/]+)\/([^/]+)$/);
    if (!file) return null;
    const name = normalizePypiName(decodeURIComponent(file[1]));
    const filename = decodeURIComponent(file[2]);
    if (filename.endsWith(".metadata")) {
      return { kind: "file-metadata", name, filename: filename.slice(0, -".metadata".length) };
    }
    const version = versionOf(filename);
    return version ? { kind: "download", name, version, filename } : null;
  },

  async fetchMetadata(name, upstream): Promise<PackageMetadata> {
    const response = await upstream(`${UPSTREAM}${name}/`, { accept: SIMPLE_JSON });
    if (response.status === 404)
      throw new RegistryError(404, "wardby_package_not_found", `PyPI has no package "${name}"`);
    if (!response.ok) throw new RegistryError(502, "wardby_upstream_error", `PyPI returned ${response.status}`);
    const index = (await response.json()) as SimpleIndex;
    const grouped = new Map<string, { files: FileRef[]; times: number[] }>();
    for (const file of index.files) {
      const version = versionOf(file.filename);
      if (!version || file.yanked) continue;
      const entry = grouped.get(version) ?? { files: [], times: [] };
      entry.files.push({
        filename: file.filename,
        version,
        upstreamUrl: file.url,
        integrity: file.hashes?.sha256 ? { algorithm: "sha256", hex: file.hashes.sha256 } : null,
        sizeBytes: file.size ?? null,
        allowed: file.filename.endsWith(".whl"),
      });
      if (file["upload-time"]) entry.times.push(Date.parse(file["upload-time"]));
      grouped.set(version, entry);
    }
    const versions = new Map<string, VersionInfo>();
    for (const [version, { files, times }] of grouped) {
      versions.set(version, {
        version,
        publishedAt: times.length === files.length ? new Date(Math.min(...times)) : null,
        dependencies: [],
        files,
      });
    }
    return { name: normalizePypiName(index.name), versions, raw: index };
  },

  renderMetadata(meta, keep, proxyBase) {
    const index = meta.raw as SimpleIndex;
    const files = index.files
      .filter((file) => file.filename.endsWith(".whl"))
      .filter((file) => keep.has(versionOf(file.filename) ?? ""))
      .map((file) => ({
        ...file,
        url: `${proxyBase}files/${encodeURIComponent(meta.name)}/${encodeURIComponent(file.filename)}`,
      }));
    return {
      contentType: SIMPLE_JSON,
      body: JSON.stringify({ meta: { "api-version": "1.1" }, name: meta.name, files, versions: [...keep] }),
    };
  },

  resolveDownload(route, meta) {
    return meta.versions.get(route.version)?.files.find((file) => file.filename === route.filename) ?? null;
  },

  resolveFileMetadata(route, meta) {
    const index = meta.raw as SimpleIndex;
    const source = index.files.find((file) => file.filename === route.filename);
    const version = versionOf(route.filename);
    const declared = source?.["core-metadata"] ?? source?.["dist-info-metadata"];
    if (!source || !version || !declared || !source.filename.endsWith(".whl")) return null;
    const sha256 = typeof declared === "object" ? declared.sha256 : undefined;
    return {
      filename: `${route.filename}.metadata`,
      version,
      upstreamUrl: `${source.url}.metadata`,
      integrity: sha256 ? { algorithm: "sha256", hex: sha256 } : null,
      sizeBytes: null,
      allowed: true,
    };
  },

  async dependenciesFromFile(route, body) {
    if (route.kind === "file-metadata") return requiresDist(new TextDecoder().decode(body));
    if (!route.filename.endsWith(".whl") || body.byteLength > WHEEL_METADATA_LIMIT) return [];
    const entries = unzipSync(body, { filter: (file) => /\.dist-info\/METADATA$/.test(file.name) });
    const metadata = Object.values(entries)[0];
    return metadata ? requiresDist(strFromU8(metadata)) : [];
  },

  workerConfig({ registryUrl, token, cacheDir }) {
    const index = new URL("simple/", registryUrl);
    index.username = "wardby";
    index.password = token;
    return {
      env: {
        PIP_INDEX_URL: index.toString(),
        PIP_TRUSTED_HOST: index.hostname,
        PIP_ONLY_BINARY: ":all:",
        PIP_CACHE_DIR: cacheDir,
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        PIP_NO_INPUT: "1",
      },
      files: [],
    };
  },
};
```

If `@renovatebot/pep440`'s root export does not provide `validRange`/`satisfies`, import them from `@renovatebot/pep440/lib/specifier.js` instead; the tests pin the behavior.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/coding/registry/pypi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/coding/registry/pypi.ts src/coding/registry/pypi.test.ts src/coding/registry/fixtures
git commit -m "feat(registry): PyPI adapter"
```

---

### Task 5: Adapter map, registry token, worker config, and profile fields behind `packages:approve`

**Files:**

- Create: `src/coding/registry/adapters.ts`, `src/coding/registry/token.ts`, `src/coding/registry/worker-config.ts`
- Test: `src/coding/registry/worker-config.test.ts`
- Modify: `src/coding/profile.ts` (fields `packageAllowlist`, `packagePolicy`)
- Modify: `src/mcp/auth/resource-server.ts:14-27` (`SCOPES_SUPPORTED`)
- Modify: `src/mcp/tools/agents.ts` (`profileJsonSchema`, `storedProfile`, gates in `create_agent` and `update_agent`)
- Modify: `prisma/schema.prisma`, create `prisma/migrations/20260925020000_coding_package_registry/migration.sql` (all registry columns and tables at once; tables are used from Task 7)
- Modify: `src/core/dispatch.ts` (snapshot)
- Test: `src/coding/profile.test.ts`, `src/mcp/tools/agents.test.ts`, `src/core/dispatch.test.ts`, `src/mcp/auth/resource-server.test.ts`

**Interfaces:**

- Produces:
  - `REGISTRY_ADAPTERS: ReadonlyMap<string, RegistryAdapter>` (npm, pypi)
  - `deriveRegistryToken(capability: string): string` → `"rrg_" + base64url(sha256("wardby-registry\0" + capability))`
  - `registryWorkerSetup(input: { proxyBaseUrl: string; capability: string; cacheRoot: string }): { env: Record<string, string>; files: { path: string; content: string; mode: number }[] }`
  - `CodingProfile.packageAllowlist: Record<string, string[]>` (default `{}`), `CodingProfile.packagePolicy: { minReleaseAgeDays?: number }` (default `{}`)
  - Prisma: `CodingAgentProfile.packageAllowlist/packagePolicy`, `CodingRun.packageAllowlist/packagePolicy`, `CodingProxySession.registryTokenHash`, models `RegistryAllowance`, `RegistryFetch`, enum `RegistryFetchOutcome`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/coding/registry/worker-config.test.ts
import { describe, expect, it } from "vitest";
import { deriveRegistryToken } from "./token.js";
import { registryWorkerSetup } from "./worker-config.js";

describe("registryWorkerSetup", () => {
  it("configures every adapter with the derived token, never the capability", () => {
    const setup = registryWorkerSetup({
      proxyBaseUrl: "http://wardby-proxy:8787",
      capability: "rrp_secret",
      cacheRoot: "/workspace/.cache",
    });
    const token = deriveRegistryToken("rrp_secret");
    expect(token).toMatch(/^rrg_[A-Za-z0-9_-]{43}$/);
    expect(setup.env.npm_config_registry).toBe("http://wardby-proxy:8787/registry/npm/");
    expect(setup.env.PIP_INDEX_URL).toContain(token);
    expect(JSON.stringify(setup)).not.toContain("rrp_secret");
    expect(setup.files.every((file) => file.path.startsWith("/workspace/.cache/"))).toBe(true);
  });
});
```

In `src/coding/profile.test.ts`, add `packageAllowlist: {}, packagePolicy: {},` to the defaults expectation and:

```ts
it("validates package allowlists per ecosystem", () => {
  const base = { repository: "openai/example" };
  expect(
    CodingProfileSchema.parse({ ...base, packageAllowlist: { npm: ["@heroui/*", "react@^19"], pypi: ["flask>=3"] } })
      .packageAllowlist,
  ).toEqual({ npm: ["@heroui/*", "react@^19"], pypi: ["flask>=3"] });
  expect(() => CodingProfileSchema.parse({ ...base, packageAllowlist: { cargo: ["serde"] } })).toThrow();
  expect(() => CodingProfileSchema.parse({ ...base, packageAllowlist: { npm: ["react@nope"] } })).toThrow();
  expect(() => CodingProfileSchema.parse({ ...base, packagePolicy: { minReleaseAgeDays: 31 } })).toThrow();
});
```

In `src/mcp/tools/agents.test.ts`, add:

```ts
it("changing packageAllowlist needs packages:approve or agents:admin", async () => {
  for (const [scopes, allowed] of [
    [["agents:write"], false],
    [["agents:write", "packages:approve"], true],
    [["agents:write", "agents:admin"], true],
  ] as const) {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", [...scopes]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);
    const result = await client.callTool({
      name: "create_agent",
      arguments: {
        name: "coder",
        systemPrompt: "Make the requested change.",
        model: "gpt-5.6-luna",
        budgetUsd: 0.25,
        kind: "coding",
        codingProfile: { repository: "openai/example", packageAllowlist: { npm: ["react"] } },
      },
    });
    expect(Boolean(result.isError)).toBe(!allowed);
    await client.close();
  }
});
```

In `src/mcp/auth/resource-server.test.ts` (or wherever `SCOPES_SUPPORTED` is asserted), expect it to contain `"packages:approve"`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/coding src/mcp/tools/agents.test.ts src/mcp/auth`
Expected: FAIL.

- [ ] **Step 3: Implement the adapter map, token and worker setup**

```ts
// src/coding/registry/adapters.ts
import { npmAdapter } from "./npm.js";
import { pypiAdapter } from "./pypi.js";
import type { EcosystemId, RegistryAdapter } from "./types.js";

export const REGISTRY_ADAPTERS: ReadonlyMap<EcosystemId, RegistryAdapter> = new Map(
  [npmAdapter, pypiAdapter].map((adapter) => [adapter.id, adapter]),
);
```

```ts
// src/coding/registry/token.ts
import { createHash } from "node:crypto";

/** A one-way, registry-only token for npm and pip. The proxy stores its hash and
 *  accepts it only on /registry/ routes, so package tools never hold the model
 *  capability. */
export function deriveRegistryToken(capability: string): string {
  return `rrg_${createHash("sha256").update("wardby-registry\0").update(capability).digest("base64url")}`;
}
```

```ts
// src/coding/registry/worker-config.ts
import { REGISTRY_ADAPTERS } from "./adapters.js";
import { deriveRegistryToken } from "./token.js";

export function registryWorkerSetup(input: { proxyBaseUrl: string; capability: string; cacheRoot: string }) {
  const token = deriveRegistryToken(input.capability);
  const env: Record<string, string> = {};
  const files: { path: string; content: string; mode: number }[] = [];
  for (const adapter of REGISTRY_ADAPTERS.values()) {
    const config = adapter.workerConfig({
      registryUrl: `${input.proxyBaseUrl.replace(/\/$/, "")}/registry/${adapter.id}/`,
      token,
      cacheDir: `${input.cacheRoot}/${adapter.id}`,
    });
    Object.assign(env, config.env);
    for (const file of config.files) {
      if (!file.path.startsWith(`${input.cacheRoot}/`)) throw new Error("registry_worker_file_outside_cache");
      files.push(file);
    }
  }
  return { env, files };
}
```

- [ ] **Step 4: Add the profile fields**

In `src/coding/profile.ts`:

```ts
import { parseAllowlist, resolvePolicy } from "./registry/allowlist.js";
import { REGISTRY_ADAPTERS } from "./registry/adapters.js";

const packageAllowlistSchema = z
  .record(z.string(), z.array(z.string().min(1).max(256)).max(256))
  .superRefine((value, ctx) => {
    try {
      parseAllowlist(value, REGISTRY_ADAPTERS);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "invalid allowlist",
      });
    }
  });
const packagePolicySchema = z
  .object({ minReleaseAgeDays: z.number().int().min(0).max(30).optional() })
  .strict()
  .superRefine((value, ctx) => {
    try {
      resolvePolicy(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid package policy" });
    }
  });
```

Add `packageAllowlist: packageAllowlistSchema` and `packagePolicy: packagePolicySchema` to `codingProfileFields`; `.default({})` in `CodingProfileSchema`, `.optional()` in `CodingProfilePatchSchema`.

- [ ] **Step 5: Add the scope and the gate**

In `src/mcp/auth/resource-server.ts`, insert `"packages:approve",` before `"agents:admin"` in `SCOPES_SUPPORTED`, with a comment: `// Approve coding agents' package allowlists (see docs/coding-packages.md).`

In `src/mcp/tools/agents.ts`, next to `requireWorkerImageRefScope`:

```ts
import { insufficientScope, protectedResourceMetadataUrl } from "../auth/resource-server.js";

/** Package allowlists widen what a run may download, so they need their own approval. */
function requirePackageApproval(ctx: McpRequestContext): void {
  if (ctx.scopes.has("packages:approve") || ctx.scopes.has("agents:admin")) return;
  throw insufficientScope(["packages:approve"], protectedResourceMetadataUrl(ctx.canonicalUri));
}
```

(If `insufficientScope` or `protectedResourceMetadataUrl` are not exported, export them from `resource-server.ts`.) In `create_agent` after the `workerImageRef` check:

```ts
const packages = args.codingProfile;
if (
  packages &&
  (Object.keys(packages.packageAllowlist ?? {}).length > 0 || Object.keys(packages.packagePolicy ?? {}).length > 0)
)
  requirePackageApproval(ctx);
```

In `update_agent` after the `workerImageRef` check:

```ts
if (args.codingProfile?.packageAllowlist !== undefined || args.codingProfile?.packagePolicy !== undefined)
  requirePackageApproval(ctx);
```

Add to `profileJsonSchema`:

```ts
    packageAllowlist: {
      type: "object",
      description: "Approved top-level packages per ecosystem (npm, pypi). Needs packages:approve or agents:admin.",
      additionalProperties: { type: "array", maxItems: 256, items: { type: "string" } },
    },
    packagePolicy: {
      type: "object",
      properties: { minReleaseAgeDays: { type: "integer", minimum: 0, maximum: 30 } },
      additionalProperties: false,
    },
```

and to `storedProfile`: `packageAllowlist: profile.packageAllowlist, packagePolicy: profile.packagePolicy,`.

- [ ] **Step 6: Schema, migration, and dispatch snapshot**

In `prisma/schema.prisma`:

- `CodingAgentProfile` and `CodingRun`: add
  ```prisma
  packageAllowlist         Json     @default("{}")
  packagePolicy            Json     @default("{}")
  ```
- `CodingRun`: add relations `registryAllowances RegistryAllowance[]` and `registryFetches RegistryFetch[]`.
- `CodingProxySession`: add `registryTokenHash String? @unique`.
- New:
  ```prisma
  enum RegistryFetchOutcome {
    served
    refused
  }

  model RegistryAllowance {
    runId     String
    ecosystem String
    name      String
    createdAt DateTime  @default(now())
    run       CodingRun @relation(fields: [runId], references: [runId], onDelete: Cascade)

    @@id([runId, ecosystem, name])
  }

  model RegistryFetch {
    id        String               @id @default(cuid())
    runId     String
    ecosystem String
    name      String
    version   String?
    filename  String?
    integrity String?
    sizeBytes Int?
    outcome   RegistryFetchOutcome
    reason    String?
    createdAt DateTime             @default(now())
    run       CodingRun            @relation(fields: [runId], references: [runId], onDelete: Cascade)

    @@index([runId, createdAt])
  }
  ```

Create `prisma/migrations/20260925020000_coding_package_registry/migration.sql`:

```sql
-- Additive: coding package registry. See
-- docs/superpowers/specs/2026-09-25-coding-package-registry-design.md.

-- CreateEnum
CREATE TYPE "RegistryFetchOutcome" AS ENUM ('served', 'refused');

-- AlterTable
ALTER TABLE "CodingAgentProfile" ADD COLUMN     "packageAllowlist" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "packagePolicy" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "CodingRun" ADD COLUMN     "packageAllowlist" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "packagePolicy" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "CodingProxySession" ADD COLUMN     "registryTokenHash" TEXT;

-- CreateTable
CREATE TABLE "RegistryAllowance" (
    "runId" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistryAllowance_pkey" PRIMARY KEY ("runId","ecosystem","name")
);

-- CreateTable
CREATE TABLE "RegistryFetch" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT,
    "filename" TEXT,
    "integrity" TEXT,
    "sizeBytes" INTEGER,
    "outcome" "RegistryFetchOutcome" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistryFetch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CodingProxySession_registryTokenHash_key" ON "CodingProxySession"("registryTokenHash");

-- CreateIndex
CREATE INDEX "RegistryFetch_runId_createdAt_idx" ON "RegistryFetch"("runId", "createdAt");

-- AddForeignKey
ALTER TABLE "RegistryAllowance" ADD CONSTRAINT "RegistryAllowance_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CodingRun"("runId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryFetch" ADD CONSTRAINT "RegistryFetch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CodingRun"("runId") ON DELETE CASCADE ON UPDATE CASCADE;
```

In `src/core/dispatch.ts` `codingRun.create` data, add:

```ts
              packageAllowlist: agent.codingProfile.packageAllowlist as Prisma.InputJsonValue,
              packagePolicy: agent.codingProfile.packagePolicy as Prisma.InputJsonValue,
```

and a dispatch test mirroring Plan A's `collectExclude` test asserting both are copied.

Run: `npm run prisma:generate`, then the drift check from `CLAUDE.md` (expect an empty migration) and `npx prisma validate`.

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run src/coding src/mcp src/core/dispatch.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A src prisma
git commit -m "feat(registry): packages:approve scope, profile allowlist, and registry tables"
```

---

### Task 6: OSV audit

**Files:**

- Create: `src/providers/coding-proxy/registry/audit.ts`
- Test: `src/providers/coding-proxy/registry/audit.test.ts`

**Interfaces:**

- Consumes: `UpstreamFetch`, `RegistryError` (Task 2).
- Produces:

```ts
export interface AdvisoryIndex {
  withheld: ReadonlyMap<string, readonly string[]>; // version -> advisory ids (HIGH/CRITICAL)
  reported: ReadonlyMap<string, readonly string[]>; // version -> advisory ids (other severities)
}
export class OsvAudit {
  constructor(options: { fetch: UpstreamFetch; failOpen: boolean; now?: () => number; ttlMs?: number });
  audit(osvEcosystem: string, name: string): Promise<AdvisoryIndex>;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/providers/coding-proxy/registry/audit.test.ts
import { describe, expect, it, vi } from "vitest";
import { OsvAudit } from "./audit.js";

const vulns = {
  vulns: [
    { id: "GHSA-high", affected: [{ versions: ["1.0.0"] }], database_specific: { severity: "HIGH" } },
    { id: "GHSA-low", affected: [{ versions: ["1.1.0"] }], database_specific: { severity: "LOW" } },
  ],
};

describe("OsvAudit", () => {
  it("withholds HIGH and CRITICAL versions and reports the rest", async () => {
    const fetch = vi.fn(async () => Response.json(vulns));
    const index = await new OsvAudit({ fetch, failOpen: false }).audit("npm", "left-pad");
    expect([...index.withheld.keys()]).toEqual(["1.0.0"]);
    expect([...index.reported.keys()]).toEqual(["1.1.0"]);
    expect(fetch).toHaveBeenCalledWith("https://api.osv.dev/v1/query", expect.objectContaining({ method: "POST" }));
  });

  it("caches per package for an hour", async () => {
    let now = 0;
    const fetch = vi.fn(async () => Response.json({ vulns: [] }));
    const audit = new OsvAudit({ fetch, failOpen: false, now: () => now });
    await audit.audit("npm", "a");
    await audit.audit("npm", "a");
    now += 3_600_001;
    await audit.audit("npm", "a");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed when OSV is unreachable, unless configured to fail open", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(new OsvAudit({ fetch, failOpen: false }).audit("npm", "a")).rejects.toMatchObject({
      status: 503,
      code: "wardby_audit_unavailable",
    });
    await expect(new OsvAudit({ fetch, failOpen: true }).audit("npm", "a")).resolves.toMatchObject({});
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/providers/coding-proxy/registry/audit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/providers/coding-proxy/registry/audit.ts
import { RegistryError, type UpstreamFetch } from "../../../coding/registry/types.js";

const OSV_QUERY = "https://api.osv.dev/v1/query";
const BLOCKING = new Set(["HIGH", "CRITICAL"]);

interface OsvVuln {
  id: string;
  affected?: { versions?: string[] }[];
  database_specific?: { severity?: string };
}

export interface AdvisoryIndex {
  withheld: ReadonlyMap<string, readonly string[]>;
  reported: ReadonlyMap<string, readonly string[]>;
}

function add(map: Map<string, string[]>, version: string, id: string) {
  map.set(version, [...(map.get(version) ?? []), id]);
}

export class OsvAudit {
  private readonly cache = new Map<string, { expires: number; index: AdvisoryIndex }>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(
    private readonly options: { fetch: UpstreamFetch; failOpen: boolean; now?: () => number; ttlMs?: number },
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 3_600_000;
  }

  async audit(osvEcosystem: string, name: string): Promise<AdvisoryIndex> {
    const key = `${osvEcosystem}:${name}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return cached.index;
    let vulns: OsvVuln[];
    try {
      vulns = await this.query(osvEcosystem, name);
    } catch {
      if (this.options.failOpen) return { withheld: new Map(), reported: new Map() };
      throw new RegistryError(
        503,
        "wardby_audit_unavailable",
        `the vulnerability audit for "${name}" could not reach OSV; try again later`,
      );
    }
    const withheld = new Map<string, string[]>();
    const reported = new Map<string, string[]>();
    for (const vuln of vulns) {
      const severity = vuln.database_specific?.severity?.toUpperCase() ?? "";
      for (const affected of vuln.affected ?? []) {
        for (const version of affected.versions ?? [])
          add(BLOCKING.has(severity) ? withheld : reported, version, vuln.id);
      }
    }
    const index = { withheld, reported };
    this.cache.set(key, { expires: this.now() + this.ttlMs, index });
    return index;
  }

  private async query(ecosystem: string, name: string): Promise<OsvVuln[]> {
    const vulns: OsvVuln[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.options.fetch(OSV_QUERY, {
        method: "POST",
        accept: "application/json",
        body: JSON.stringify({ package: { name, ecosystem }, ...(pageToken ? { page_token: pageToken } : {}) }),
      });
      if (!response.ok) throw new Error(`osv_status_${response.status}`);
      const page = (await response.json()) as { vulns?: OsvVuln[]; next_page_token?: string };
      vulns.push(...(page.vulns ?? []));
      pageToken = page.next_page_token;
    } while (pageToken);
    return vulns;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/providers/coding-proxy/registry/audit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/coding-proxy/registry/audit.ts src/providers/coding-proxy/registry/audit.test.ts
git commit -m "feat(registry): OSV audit with caching and fail-closed default"
```

---

### Task 7: Registry store and registry token on proxy sessions

**Files:**

- Create: `src/providers/coding-proxy/registry/store.ts` (interface + `MemoryRegistryStore`)
- Create: `src/providers/coding-proxy/registry/prisma-store.ts`
- Test: `src/providers/coding-proxy/registry/prisma-store.database.test.ts`
- Modify: `src/providers/coding-proxy/types.ts` (`CreateProxySessionInput.registryTokenHash`), `proxy.ts` (`createSession`), `prisma-ledger.ts` (`createSession` INSERT), `memory-ledger.ts`
- Test: `src/providers/coding-proxy/proxy.test.ts`

**Interfaces:**

- Consumes: Task 5 tables and `deriveRegistryToken`; `capabilityHash` from `proxy.ts`.
- Produces:

```ts
export interface RegistryRunContext {
  runId: string;
  deadlineAt: Date;
  allowlist: PackageAllowlist;
  policy: unknown; // resolved with resolvePolicy()
}
export interface RegistryFetchRecord {
  runId: string;
  ecosystem: string;
  name: string;
  version?: string;
  filename?: string;
  integrity?: string;
  sizeBytes?: number;
  outcome: "served" | "refused";
  reason?: string;
}
export interface RegistryStore {
  findRunByRegistryTokenHash(hash: string, now: Date): Promise<RegistryRunContext | null>;
  isAllowedDependency(runId: string, ecosystem: string, name: string): Promise<boolean>;
  addAllowances(runId: string, ecosystem: string, names: readonly string[]): Promise<void>;
  recordFetch(record: RegistryFetchRecord): Promise<void>;
  usage(runId: string): Promise<{ files: number; bytes: number }>;
  listFetches(runId: string): Promise<(RegistryFetchRecord & { createdAt: Date })[]>;
}
export class MemoryRegistryStore implements RegistryStore {
  /* maps; `contexts` settable by tests */
}
export class PrismaRegistryStore implements RegistryStore {
  constructor(db: PrismaClient);
}
```

- [ ] **Step 1: Write the failing tests**

In `src/providers/coding-proxy/proxy.test.ts`, add:

```ts
it("stores the hash of a registry-only token derived from each new capability", async () => {
  const h = harness();
  const { capability } = await h.proxy.createSession(sessionInput());
  const session = await h.ledger.findSessionByCapabilityHash(capabilityHash(capability));
  expect(session?.registryTokenHash).toBe(capabilityHash(deriveRegistryToken(capability)));
});
```

(Use the file's existing `harness()` and session-input helper; import `deriveRegistryToken` from `../../coding/registry/token.js` and `capabilityHash` from `./proxy.js`, exporting it if needed.)

```ts
// src/providers/coding-proxy/registry/prisma-store.database.test.ts
// Follow prisma-ledger.database.test.ts for setup: a PrismaClient on DATABASE_URL,
// creating an Agent, Run, CodingRun (packageAllowlist {npm:["react"]}) and an active
// CodingProxySession with registryTokenHash "h1" and a future deadline.
import { describe, expect, it } from "vitest";
import { PrismaRegistryStore } from "./prisma-store.js";

describe("PrismaRegistryStore (database)", () => {
  it("resolves a live session's run, grows allowances, and totals usage", async () => {
    const { db, runId } = await seedRun({ registryTokenHash: "h1", allowlist: { npm: ["react"] } });
    const store = new PrismaRegistryStore(db);
    const context = await store.findRunByRegistryTokenHash("h1", new Date());
    expect(context).toMatchObject({ runId, allowlist: { npm: ["react"] } });
    expect(await store.isAllowedDependency(runId, "npm", "loose-envify")).toBe(false);
    await store.addAllowances(runId, "npm", ["loose-envify", "loose-envify"]);
    expect(await store.isAllowedDependency(runId, "npm", "loose-envify")).toBe(true);
    await store.recordFetch({
      runId,
      ecosystem: "npm",
      name: "react",
      version: "19.0.0",
      sizeBytes: 100,
      outcome: "served",
    });
    await store.recordFetch({
      runId,
      ecosystem: "npm",
      name: "evil",
      outcome: "refused",
      reason: "wardby_package_not_allowed",
    });
    expect(await store.usage(runId)).toEqual({ files: 1, bytes: 100 });
    expect(await store.findRunByRegistryTokenHash("h1", new Date(Date.now() + 10 * 86_400_000))).toBeNull();
  });
});
```

Write `seedRun` in the test file using the same inserts `prisma-ledger.database.test.ts` uses for its session fixtures.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/providers/coding-proxy/proxy.test.ts src/providers/coding-proxy/registry/prisma-store.database.test.ts`
Expected: FAIL.

- [ ] **Step 3: Store the registry token hash at session creation**

- `types.ts`: add `registryTokenHash: string;` to `CreateProxySessionInput` and `registryTokenHash?: string | null;` to `ProxySession`.
- `proxy.ts` `createSession`: after minting `capability`, compute `const registryTokenHash = capabilityHash(deriveRegistryToken(capability));` and pass it to `ledger.createSession({ ..., registryTokenHash })`.
- `prisma-ledger.ts` `createSession`: add `"registryTokenHash"` to the INSERT column list and `${input.registryTokenHash}` to the values; include it in the SELECT that builds `ProxySession` in `findSessionByCapabilityHash`.
- `memory-ledger.ts`: store and return it.

- [ ] **Step 4: Implement the stores**

```ts
// src/providers/coding-proxy/registry/store.ts
import type { PackageAllowlist } from "../../../coding/registry/allowlist.js";

export interface RegistryRunContext {
  runId: string;
  deadlineAt: Date;
  allowlist: PackageAllowlist;
  policy: unknown;
}
export interface RegistryFetchRecord {
  runId: string;
  ecosystem: string;
  name: string;
  version?: string;
  filename?: string;
  integrity?: string;
  sizeBytes?: number;
  outcome: "served" | "refused";
  reason?: string;
}
export interface RegistryStore {
  findRunByRegistryTokenHash(hash: string, now: Date): Promise<RegistryRunContext | null>;
  isAllowedDependency(runId: string, ecosystem: string, name: string): Promise<boolean>;
  addAllowances(runId: string, ecosystem: string, names: readonly string[]): Promise<void>;
  recordFetch(record: RegistryFetchRecord): Promise<void>;
  usage(runId: string): Promise<{ files: number; bytes: number }>;
  listFetches(runId: string): Promise<(RegistryFetchRecord & { createdAt: Date })[]>;
}

export class MemoryRegistryStore implements RegistryStore {
  readonly contexts = new Map<string, RegistryRunContext>();
  readonly allowances = new Set<string>();
  readonly fetches: (RegistryFetchRecord & { createdAt: Date })[] = [];

  async findRunByRegistryTokenHash(hash: string, now: Date) {
    const context = this.contexts.get(hash);
    return context && context.deadlineAt > now ? context : null;
  }
  async isAllowedDependency(runId: string, ecosystem: string, name: string) {
    return this.allowances.has(`${runId}\0${ecosystem}\0${name}`);
  }
  async addAllowances(runId: string, ecosystem: string, names: readonly string[]) {
    for (const name of names) this.allowances.add(`${runId}\0${ecosystem}\0${name}`);
  }
  async recordFetch(record: RegistryFetchRecord) {
    this.fetches.push({ ...record, createdAt: new Date() });
  }
  async usage(runId: string) {
    const served = this.fetches.filter((fetch) => fetch.runId === runId && fetch.outcome === "served");
    return { files: served.length, bytes: served.reduce((sum, fetch) => sum + (fetch.sizeBytes ?? 0), 0) };
  }
  async listFetches(runId: string) {
    return this.fetches.filter((fetch) => fetch.runId === runId);
  }
}
```

```ts
// src/providers/coding-proxy/registry/prisma-store.ts
import type { PrismaClient } from "@prisma/client";
import type { PackageAllowlist } from "../../../coding/registry/allowlist.js";
import type { RegistryFetchRecord, RegistryRunContext, RegistryStore } from "./store.js";

export class PrismaRegistryStore implements RegistryStore {
  constructor(private readonly db: PrismaClient) {}

  async findRunByRegistryTokenHash(hash: string, now: Date): Promise<RegistryRunContext | null> {
    const session = await this.db.codingProxySession.findUnique({
      where: { registryTokenHash: hash },
      select: {
        runId: true,
        status: true,
        deadlineAt: true,
        codingRun: { select: { packageAllowlist: true, packagePolicy: true } },
      },
    });
    if (!session || session.status !== "active" || session.deadlineAt <= now) return null;
    return {
      runId: session.runId,
      deadlineAt: session.deadlineAt,
      allowlist: (session.codingRun.packageAllowlist ?? {}) as PackageAllowlist,
      policy: session.codingRun.packagePolicy,
    };
  }

  async isAllowedDependency(runId: string, ecosystem: string, name: string): Promise<boolean> {
    const row = await this.db.registryAllowance.findUnique({
      where: { runId_ecosystem_name: { runId, ecosystem, name } },
      select: { runId: true },
    });
    return row !== null;
  }

  async addAllowances(runId: string, ecosystem: string, names: readonly string[]): Promise<void> {
    if (names.length === 0) return;
    await this.db.registryAllowance.createMany({
      data: [...new Set(names)].map((name) => ({ runId, ecosystem, name })),
      skipDuplicates: true,
    });
  }

  async recordFetch(record: RegistryFetchRecord): Promise<void> {
    await this.db.registryFetch.create({ data: record });
  }

  async usage(runId: string): Promise<{ files: number; bytes: number }> {
    const totals = await this.db.registryFetch.aggregate({
      where: { runId, outcome: "served" },
      _count: { _all: true },
      _sum: { sizeBytes: true },
    });
    return { files: totals._count._all, bytes: totals._sum.sizeBytes ?? 0 };
  }

  async listFetches(runId: string) {
    const rows = await this.db.registryFetch.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });
    return rows.map((row) => ({
      runId: row.runId,
      ecosystem: row.ecosystem,
      name: row.name,
      version: row.version ?? undefined,
      filename: row.filename ?? undefined,
      integrity: row.integrity ?? undefined,
      sizeBytes: row.sizeBytes ?? undefined,
      outcome: row.outcome,
      reason: row.reason ?? undefined,
      createdAt: row.createdAt,
    }));
  }
}
```

(If the `CodingProxySession` → `CodingRun` relation field has a different name than `codingRun`, use the name in `schema.prisma`.)

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/providers/coding-proxy`
Expected: PASS (Postgres running).

- [ ] **Step 6: Commit**

```bash
git add src/providers/coding-proxy
git commit -m "feat(registry): run-scoped registry store and registry-only session token"
```

---

### Task 8: Registry core service

**Files:**

- Create: `src/providers/coding-proxy/registry/service.ts`
- Test: `src/providers/coding-proxy/registry/service.test.ts`

**Interfaces:**

- Consumes: Tasks 2–7.
- Produces:

```ts
export interface RegistryLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  idleTimeoutMs: number;
}
export type RegistryResponse =
  | { status: number; contentType: string; body: string }
  | { status: 200; contentType: string; stream: ReadableStream<Uint8Array> };
export interface RegistryRequest {
  method: string;
  ecosystem: string;
  subpath: string;
  token: string;
  signal: AbortSignal;
}
export class RegistryService {
  constructor(options: {
    adapters: ReadonlyMap<string, RegistryAdapter>;
    store: RegistryStore;
    audit: Pick<OsvAudit, "audit">;
    upstream: UpstreamFetch;
    proxyBase: string; // "http://wardby-proxy:8787/registry/"
    limits: RegistryLimits;
    now?: () => Date;
    metadataTtlMs?: number;
  });
  handle(request: RegistryRequest): Promise<RegistryResponse>;
}
export function errorResponse(error: RegistryError): RegistryResponse;
```

- [ ] **Step 1: Write the failing tests**

Build a small fake adapter in the test (not npm) so the core is tested independently:

```ts
// src/providers/coding-proxy/registry/service.test.ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RegistryAdapter, PackageMetadata } from "../../../coding/registry/types.js";
import { capabilityHash } from "../proxy.js";
import { MemoryRegistryStore } from "./store.js";
import { RegistryService } from "./service.js";

const DAY = 86_400_000;
const NOW = new Date("2026-09-25T00:00:00Z");
const tarball = new TextEncoder().encode("package bytes");
const sha512 = createHash("sha512").update(tarball).digest("hex");

function meta(name: string, versions: Record<string, { ageDays: number | null; deps?: string[] }>): PackageMetadata {
  return {
    name,
    raw: null,
    versions: new Map(
      Object.entries(versions).map(([version, info]) => [
        version,
        {
          version,
          publishedAt: info.ageDays === null ? null : new Date(NOW.getTime() - info.ageDays * DAY),
          dependencies: info.deps ?? [],
          files: [
            {
              filename: `${version}.tgz`,
              version,
              upstreamUrl: `https://upstream.test/${name}/${version}.tgz`,
              integrity: { algorithm: "sha512", hex: sha512 },
              sizeBytes: tarball.byteLength,
              allowed: true,
            },
          ],
        },
      ]),
    ),
  };
}

const catalog: Record<string, PackageMetadata> = {
  app: meta("app", { "1.0.0": { ageDays: 10, deps: ["dep"] }, "2.0.0": { ageDays: 1 } }),
  dep: meta("dep", { "1.0.0": { ageDays: 10 } }),
  stranger: meta("stranger", { "1.0.0": { ageDays: 10 } }),
};

const fakeAdapter: RegistryAdapter = {
  id: "fake",
  osvEcosystem: "npm",
  upstreamHosts: ["upstream.test"],
  collectExclude: [],
  parseAllowlistEntry: (raw) => ({ name: raw, wildcard: false }),
  normalizeName: (name) => name,
  satisfies: () => true,
  route: (_method, subpath) => {
    const download = subpath.match(/^dl\/([^/]+)\/([^/]+)$/);
    return download
      ? { kind: "download", name: download[1], version: download[2], filename: `${download[2]}.tgz` }
      : { kind: "metadata", name: subpath };
  },
  fetchMetadata: async (name) => catalog[name],
  renderMetadata: (m, keep) => ({ contentType: "application/json", body: JSON.stringify([...keep]) }),
  resolveDownload: (route, m) => m.versions.get(route.version)?.files[0] ?? null,
  workerConfig: () => ({ env: {}, files: [] }),
};

function service(overrides: { upstreamBody?: Uint8Array; withheld?: string[] } = {}) {
  const store = new MemoryRegistryStore();
  store.contexts.set(capabilityHash("rrg_token"), {
    runId: "run-1",
    deadlineAt: new Date(NOW.getTime() + DAY),
    allowlist: { fake: ["app"] },
    policy: {},
  });
  const registry = new RegistryService({
    adapters: new Map([["fake", fakeAdapter]]),
    store,
    audit: {
      audit: async () => ({
        withheld: new Map((overrides.withheld ?? []).map((v) => [v, ["GHSA-x"]])),
        reported: new Map(),
      }),
    },
    upstream: async () => new Response(overrides.upstreamBody ?? tarball),
    proxyBase: "http://wardby-proxy:8787/registry/",
    limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
    now: () => NOW,
  });
  return { registry, store };
}

const request = (subpath: string, token = "rrg_token") => ({
  method: "GET",
  ecosystem: "fake",
  subpath,
  token,
  signal: new AbortController().signal,
});

describe("RegistryService", () => {
  it("rejects an unknown token", async () => {
    const { registry } = service();
    await expect(registry.handle(request("app", "nope"))).resolves.toMatchObject({ status: 401 });
  });

  it("refuses and records a package outside the allowlist and its graph", async () => {
    const { registry, store } = service();
    const response = await registry.handle(request("stranger"));
    expect(response).toMatchObject({ status: 403 });
    expect("body" in response && response.body).toContain("wardby_package_not_allowed");
    expect(store.fetches[0]).toMatchObject({ name: "stranger", outcome: "refused" });
  });

  it("serves only versions older than the release age and grows the graph from them", async () => {
    const { registry, store } = service();
    const response = await registry.handle(request("app"));
    expect(response).toMatchObject({ status: 200, body: JSON.stringify(["1.0.0"]) });
    expect(await store.isAllowedDependency("run-1", "fake", "dep")).toBe(true);
    await expect(registry.handle(request("dep"))).resolves.toMatchObject({ status: 200 });
  });

  it("withholds versions with blocking advisories", async () => {
    const { registry } = service({ withheld: ["1.0.0"] });
    const response = await registry.handle(request("app"));
    expect(response).toMatchObject({ status: 404 });
  });

  it("streams a download, verifies integrity, and records it", async () => {
    const { registry, store } = service();
    const response = await registry.handle(request("dl/app/1.0.0"));
    if (!("stream" in response)) throw new Error("expected a stream");
    expect(new Uint8Array(await new Response(response.stream).arrayBuffer())).toEqual(tarball);
    expect(store.fetches.at(-1)).toMatchObject({ name: "app", version: "1.0.0", outcome: "served" });
  });

  it("errors the stream when the bytes do not match the published integrity", async () => {
    const { registry, store } = service({ upstreamBody: new TextEncoder().encode("tampered") });
    const response = await registry.handle(request("dl/app/1.0.0"));
    if (!("stream" in response)) throw new Error("expected a stream");
    await expect(new Response(response.stream).arrayBuffer()).rejects.toThrow();
    expect(store.fetches.at(-1)).toMatchObject({ outcome: "refused", reason: "wardby_integrity_mismatch" });
  });

  it("refuses a download of a filtered version", async () => {
    const { registry } = service();
    await expect(registry.handle(request("dl/app/2.0.0"))).resolves.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/providers/coding-proxy/registry/service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

```ts
// src/providers/coding-proxy/registry/service.ts
import { createHash } from "node:crypto";
import { matchRoot, parseAllowlist, resolvePolicy } from "../../../coding/registry/allowlist.js";
import {
  RegistryError,
  type AllowlistEntry,
  type DownloadRoute,
  type FileMetadataRoute,
  type FileRef,
  type PackageMetadata,
  type RegistryAdapter,
  type UpstreamFetch,
} from "../../../coding/registry/types.js";
import { capabilityHash } from "../proxy.js";
import type { OsvAudit } from "./audit.js";
import type { RegistryRunContext, RegistryStore } from "./store.js";

const DAY_MS = 86_400_000;
const DEPENDENCY_BUFFER_LIMIT = 64 * 1024 * 1024;

export interface RegistryLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  idleTimeoutMs: number;
}
export type RegistryResponse =
  | { status: number; contentType: string; body: string }
  | { status: 200; contentType: string; stream: ReadableStream<Uint8Array> };
export interface RegistryRequest {
  method: string;
  ecosystem: string;
  subpath: string;
  token: string;
  signal: AbortSignal;
}

export function errorResponse(error: RegistryError): RegistryResponse {
  return {
    status: error.status,
    contentType: "application/json",
    body: JSON.stringify({ error: `${error.code}: ${error.message}` }),
  };
}

export class RegistryService {
  private readonly metadataCache = new Map<string, { expires: number; meta: PackageMetadata }>();
  private readonly now: () => Date;
  private readonly metadataTtlMs: number;

  constructor(
    private readonly options: {
      adapters: ReadonlyMap<string, RegistryAdapter>;
      store: RegistryStore;
      audit: Pick<OsvAudit, "audit">;
      upstream: UpstreamFetch;
      proxyBase: string;
      limits: RegistryLimits;
      now?: () => Date;
      metadataTtlMs?: number;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.metadataTtlMs = options.metadataTtlMs ?? 300_000;
  }

  async handle(request: RegistryRequest): Promise<RegistryResponse> {
    try {
      return await this.dispatch(request);
    } catch (error) {
      if (error instanceof RegistryError) return errorResponse(error);
      return errorResponse(new RegistryError(502, "wardby_upstream_error", "the package registry request failed"));
    }
  }

  private async dispatch(request: RegistryRequest): Promise<RegistryResponse> {
    const adapter = this.options.adapters.get(request.ecosystem);
    if (!adapter) throw new RegistryError(404, "wardby_registry_unknown", `no registry named "${request.ecosystem}"`);
    const context = await this.options.store.findRunByRegistryTokenHash(capabilityHash(request.token), this.now());
    if (!context) throw new RegistryError(401, "invalid_capability", "the registry token is not valid for a live run");
    const route = adapter.route(request.method, request.subpath, new Headers());
    if (!route) throw new RegistryError(404, "wardby_route_unknown", "unknown registry path");

    const name = adapter.normalizeName(route.name);
    const root = await this.authorize(adapter, context, name);
    const meta = await this.metadata(adapter, name);
    const keep = await this.keptVersions(adapter, context, meta, root);

    if (route.kind === "metadata") {
      if (keep.size === 0) {
        await this.refuse(context, adapter, name, "wardby_version_filtered");
        throw new RegistryError(
          404,
          "wardby_version_filtered",
          `every matching version of "${name}" is outside the allowlisted range, newer than the release-age limit, or has a high-severity advisory`,
        );
      }
      const dependencies = [...keep].flatMap((version) => meta.versions.get(version)?.dependencies ?? []);
      await this.options.store.addAllowances(context.runId, adapter.id, dependencies.map(adapter.normalizeName));
      const document = adapter.renderMetadata(meta, keep, `${this.options.proxyBase}${adapter.id}/`);
      return { status: 200, contentType: document.contentType, body: document.body };
    }

    const file =
      route.kind === "download"
        ? adapter.resolveDownload(route, meta)
        : (adapter.resolveFileMetadata?.(route, meta) ?? null);
    if (!file || !keep.has(file.version)) {
      await this.refuse(context, adapter, name, "wardby_version_filtered", file ?? undefined);
      throw new RegistryError(
        404,
        "wardby_version_filtered",
        `"${name}" ${route.kind === "download" ? route.version : ""} is not available to this run`,
      );
    }
    if (!file.allowed) {
      await this.refuse(context, adapter, name, "wardby_file_not_allowed", file);
      throw new RegistryError(
        403,
        "wardby_file_not_allowed",
        `"${file.filename}" is a source distribution; only wheels are allowed`,
      );
    }
    return this.download(adapter, context, name, route, file, request.signal);
  }

  private async authorize(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    name: string,
  ): Promise<AllowlistEntry | undefined> {
    const entries = parseAllowlist(context.allowlist, this.options.adapters).get(adapter.id) ?? [];
    const root = matchRoot(entries, name);
    if (root || (await this.options.store.isAllowedDependency(context.runId, adapter.id, name))) return root;
    await this.refuse(context, adapter, name, "wardby_package_not_allowed");
    const hint =
      entries.length === 0
        ? `this agent has no ${adapter.id} package allowlist`
        : `"${name}" is not on this agent's ${adapter.id} package allowlist`;
    throw new RegistryError(403, "wardby_package_not_allowed", hint);
  }

  private async metadata(adapter: RegistryAdapter, name: string): Promise<PackageMetadata> {
    const key = `${adapter.id}:${name}`;
    const cached = this.metadataCache.get(key);
    const now = this.now().getTime();
    if (cached && cached.expires > now) return cached.meta;
    const meta = await adapter.fetchMetadata(name, this.options.upstream);
    this.metadataCache.set(key, { expires: now + this.metadataTtlMs, meta });
    return meta;
  }

  private async keptVersions(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    meta: PackageMetadata,
    root: AllowlistEntry | undefined,
  ): Promise<Set<string>> {
    const { minReleaseAgeDays } = resolvePolicy(context.policy);
    const cutoff = this.now().getTime() - minReleaseAgeDays * DAY_MS;
    const advisories = await this.options.audit.audit(adapter.osvEcosystem, meta.name);
    const keep = new Set<string>();
    for (const info of meta.versions.values()) {
      if (root?.range && !adapter.satisfies(info.version, root.range)) continue;
      if (!info.publishedAt || info.publishedAt.getTime() > cutoff) continue;
      if (advisories.withheld.has(info.version)) continue;
      keep.add(info.version);
    }
    return keep;
  }

  private async refuse(
    context: RegistryRunContext,
    adapter: RegistryAdapter,
    name: string,
    reason: string,
    file?: FileRef,
  ) {
    await this.options.store.recordFetch({
      runId: context.runId,
      ecosystem: adapter.id,
      name,
      version: file?.version,
      filename: file?.filename,
      outcome: "refused",
      reason,
    });
  }

  private async download(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    name: string,
    route: DownloadRoute | FileMetadataRoute,
    file: FileRef,
    signal: AbortSignal,
  ): Promise<RegistryResponse> {
    const { limits, store } = this.options;
    const usage = await store.usage(context.runId);
    if (usage.files >= limits.maxFiles)
      throw new RegistryError(429, "wardby_package_limit", "this run has reached its package file limit");
    if (file.sizeBytes !== null && file.sizeBytes > limits.maxFileBytes) {
      await this.refuse(context, adapter, name, "wardby_package_too_large", file);
      throw new RegistryError(413, "wardby_package_too_large", `"${file.filename}" exceeds the per-file size limit`);
    }
    const upstream = await this.options.upstream(file.upstreamUrl, { signal });
    if (!upstream.ok || !upstream.body)
      throw new RegistryError(502, "wardby_upstream_error", `the registry returned ${upstream.status}`);

    const hash = file.integrity ? createHash(file.integrity.algorithm) : null;
    const buffered: Uint8Array[] = [];
    let bytes = 0;
    let idle: NodeJS.Timeout | undefined;
    const reader = upstream.body.getReader();
    const remainingTotal = limits.maxTotalBytes - usage.bytes;
    const fail = async (controller: ReadableStreamDefaultController<Uint8Array>, reason: string) => {
      clearTimeout(idle);
      await reader.cancel().catch(() => undefined);
      await this.refuse(context, adapter, name, reason, file);
      controller.error(new RegistryError(502, reason, `download of "${file.filename}" stopped: ${reason}`));
    };

    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        clearTimeout(idle);
        idle = setTimeout(() => void fail(controller, "wardby_download_idle"), limits.idleTimeoutMs);
        const { done, value } = await reader.read();
        clearTimeout(idle);
        if (done) {
          if (hash && hash.digest("hex") !== file.integrity!.hex) return fail(controller, "wardby_integrity_mismatch");
          await store.recordFetch({
            runId: context.runId,
            ecosystem: adapter.id,
            name,
            version: file.version,
            filename: file.filename,
            integrity: file.integrity ? `${file.integrity.algorithm}:${file.integrity.hex}` : undefined,
            sizeBytes: bytes,
            outcome: "served",
          });
          if (adapter.dependenciesFromFile && buffered.length > 0) {
            const body = Buffer.concat(buffered);
            const names = await adapter.dependenciesFromFile(route, body).catch(() => []);
            await store.addAllowances(context.runId, adapter.id, names.map(adapter.normalizeName));
          }
          controller.close();
          return;
        }
        bytes += value.byteLength;
        if (bytes > limits.maxFileBytes) return fail(controller, "wardby_package_too_large");
        if (bytes > remainingTotal) return fail(controller, "wardby_package_limit");
        hash?.update(value);
        if (adapter.dependenciesFromFile && bytes <= DEPENDENCY_BUFFER_LIMIT) buffered.push(value);
        controller.enqueue(value);
      },
      cancel: async () => {
        clearTimeout(idle);
        await reader.cancel().catch(() => undefined);
      },
    });
    const contentType = route.kind === "file-metadata" ? "text/plain" : "application/octet-stream";
    return { status: 200, contentType, stream };
  }
}
```

(Export `capabilityHash` from `proxy.ts` if it is not already exported.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/providers/coding-proxy/registry/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/coding-proxy/registry/service.ts src/providers/coding-proxy/registry/service.test.ts src/providers/coding-proxy/proxy.ts
git commit -m "feat(registry): core service with allowlist graph, filters, streaming and integrity"
```

---

### Task 9: Registry routes in the proxy server, runtime wiring, and real clients

**Files:**

- Modify: `src/providers/coding-proxy/server.ts` (route `/registry/`), `runtime.ts` (construct `RegistryService`)
- Test: `src/providers/coding-proxy/server.test.ts`
- Create: `src/providers/coding-proxy/registry/clients.integration.test.ts`

**Interfaces:**

- Consumes: `RegistryService` (Task 8), `REGISTRY_ADAPTERS`, `PrismaRegistryStore`, `OsvAudit`, `createPinnedProxyFetch`.
- Produces: `CodingProxyServerConfig.registry?: Pick<RegistryService, "handle">`; env settings `REGISTRY_MAX_FILE_MB`, `REGISTRY_MAX_TOTAL_MB`, `REGISTRY_MAX_FILES`, `REGISTRY_IDLE_TIMEOUT_MS`, `REGISTRY_AUDIT_FAIL_OPEN`.

- [ ] **Step 1: Write the failing server tests**

In `src/providers/coding-proxy/server.test.ts`, following its real-HTTP style:

```ts
it("routes /registry/ requests with bearer or basic auth to the registry and streams the result", async () => {
  const calls: { ecosystem: string; subpath: string; token: string }[] = [];
  const registry = {
    handle: async (request: { ecosystem: string; subpath: string; token: string }) => {
      calls.push(request);
      return request.subpath.startsWith("-/tarball")
        ? { status: 200 as const, contentType: "application/octet-stream", stream: new Response("bytes").body! }
        : { status: 200, contentType: "application/json", body: "{}" };
    },
  };
  const server = await startCodingProxyServer(fakeProxy(), {
    host: "127.0.0.1",
    port: 0,
    expectedHost: undefined,
    registry,
  });
  const base = `http://127.0.0.1:${server.port}/registry`;
  await fetch(`${base}/npm/react`, { headers: { authorization: "Bearer rrg_a" } });
  const tar = await fetch(`${base}/npm/-/tarball/react/19.0.0`, {
    headers: { authorization: `Basic ${Buffer.from("wardby:rrg_b").toString("base64")}` },
  });
  expect(await tar.text()).toBe("bytes");
  expect(calls).toEqual([
    expect.objectContaining({ ecosystem: "npm", subpath: "react", token: "rrg_a" }),
    expect.objectContaining({ ecosystem: "npm", subpath: "-/tarball/react/19.0.0", token: "rrg_b" }),
  ]);
  const post = await fetch(`${base}/npm/react`, { method: "POST" });
  expect(post.status).toBe(405);
  await server.close();
});

it("returns 404 for /registry/ when no registry is configured", async () => {
  const server = await startCodingProxyServer(fakeProxy(), { host: "127.0.0.1", port: 0 });
  expect((await fetch(`http://127.0.0.1:${server.port}/registry/npm/react`)).status).toBe(404);
  await server.close();
});
```

(Use the file's existing fake `CodingProxy` factory in place of `fakeProxy()`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/providers/coding-proxy/server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Route `/registry/` in the server**

In `server.ts`, add `registry?: Pick<RegistryService, "handle">;` to `CodingProxyServerConfig`. In the request handler, **after** the `expectedHost` check and **before** `routeProtocol`:

```ts
if (request.url?.startsWith("/registry/")) {
  if (!config.registry) return sendJson(response, 404, { error: "not_found" });
  if (request.method !== "GET" && request.method !== "HEAD")
    return sendJson(response, 405, { error: "method_not_allowed" });
  const match = request.url.match(/^\/registry\/([a-z0-9-]+)\/(.*)$/);
  if (!match) return sendJson(response, 404, { error: "not_found" });
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  const result = await config.registry.handle({
    method: request.method,
    ecosystem: match[1],
    subpath: match[2].split("?")[0],
    token: registryToken(request.headers.authorization),
    signal: controller.signal,
  });
  response.statusCode = result.status;
  response.setHeader("content-type", result.contentType);
  if ("body" in result) return void response.end(request.method === "HEAD" ? undefined : result.body);
  if (request.method === "HEAD") return void response.end();
  Readable.fromWeb(result.stream as import("node:stream/web").ReadableStream)
    .on("error", () => response.destroy())
    .pipe(response);
  return;
}
```

with helpers:

```ts
function registryToken(authorization: string | undefined): string {
  if (!authorization) return "";
  const bearerToken = bearer(authorization);
  if (bearerToken) return bearerToken;
  const basic = authorization.match(/^Basic ([A-Za-z0-9+/=]+)$/);
  if (!basic) return "";
  const decoded = Buffer.from(basic[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon >= 0 ? decoded.slice(colon + 1) : "";
}
```

(Use the file's existing JSON-error helper in place of `sendJson` if it has a different name; import `Readable` from `node:stream`.)

- [ ] **Step 4: Wire the service in the runtime**

In `runtime.ts`:

```ts
import { REGISTRY_ADAPTERS } from "../../coding/registry/adapters.js";
import { OsvAudit } from "./registry/audit.js";
import { PrismaRegistryStore } from "./registry/prisma-store.js";
import { RegistryService } from "./registry/service.js";
import { createPinnedProxyFetch } from "./secure-fetch.js";

const MIB = 1024 * 1024;
function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// inside startConfiguredCodingProxy, after constructing `proxy`:
const upstreamHosts = [...new Set([...REGISTRY_ADAPTERS.values()].flatMap((adapter) => adapter.upstreamHosts))];
const pinned = createPinnedProxyFetch({ allowedHosts: [...upstreamHosts, "api.osv.dev"] });
const upstream = (
  url: string,
  init: { method?: "GET" | "POST"; body?: string; accept?: string; signal?: AbortSignal } = {},
) =>
  pinned(url, {
    method: init.method ?? "GET",
    body: init.body,
    signal: init.signal,
    redirect: "error",
    headers: {
      ...(init.accept ? { accept: init.accept } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
const registry = new RegistryService({
  adapters: REGISTRY_ADAPTERS,
  store: new PrismaRegistryStore(options.db),
  audit: new OsvAudit({ fetch: upstream, failOpen: env.REGISTRY_AUDIT_FAIL_OPEN === "true" }),
  upstream,
  proxyBase: `http://${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}/registry/`,
  limits: {
    maxFileBytes: positiveInt(env.REGISTRY_MAX_FILE_MB, 200) * MIB,
    maxTotalBytes: positiveInt(env.REGISTRY_MAX_TOTAL_MB, 2048) * MIB,
    maxFiles: positiveInt(env.REGISTRY_MAX_FILES, 5000),
    idleTimeoutMs: positiveInt(env.REGISTRY_IDLE_TIMEOUT_MS, 120_000),
  },
});
```

and pass `registry` in the `startServer(proxy, { ... })` config. Extend `runtime.test.ts`'s injected `startServer` assertion to check that a `registry` was passed.

- [ ] **Step 5: Real-client integration test**

```ts
// src/providers/coding-proxy/registry/clients.integration.test.ts
// Starts a real proxy server (startCodingProxyServer) with a RegistryService over
// MemoryRegistryStore and an `upstream` that serves the committed npm fixture and a
// generated tarball (a tiny package.json-only .tgz built with tar-stream + zlib, with
// its integrity written into the fixture copy). Then runs the real npm client:
//
//   npm install left-pad --registry http://127.0.0.1:<port>/registry/npm/ \
//     --userconfig <tmp>/npmrc --cache <tmp>/cache --ignore-scripts --no-audit --no-fund
//
// in a temporary project directory, with the npmrc from npmAdapter.workerConfig()
// (registryUrl pointing at 127.0.0.1 instead of wardby-proxy). Assert exit code 0,
// node_modules/left-pad/package.json exists, and the store recorded one served fetch.
// A second case installs a name missing from the allowlist and asserts npm's stderr
// contains "wardby_package_not_allowed".
//
// If `pip` is on PATH, a third case does the same for `pip install --target <tmp>/t flask`
// against the PyPI fixture and a generated wheel; otherwise it is skipped with it.skipIf.
```

Implement those three cases concretely; skip the whole file with `describe.skipIf(!process.env.RUN_CLIENT_INTEGRATION)` so the default suite stays hermetic, and document `RUN_CLIENT_INTEGRATION=1 npx vitest run src/providers/coding-proxy/registry/clients.integration.test.ts` in the test file header.

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/providers/coding-proxy`
Expected: PASS.
Run: `RUN_CLIENT_INTEGRATION=1 npx vitest run src/providers/coding-proxy/registry/clients.integration.test.ts`
Expected: PASS (npm case; pip case where available).

- [ ] **Step 7: Commit**

```bash
git add src/providers/coding-proxy
git commit -m "feat(registry): serve npm and PyPI through the coding proxy"
```

---

### Task 10: Drivers configure npm and pip for the agent

**Files:**

- Modify: `src/coding-worker/driver.ts` (`runCodingWorker`, `workerEnvironment` call site)
- Modify: `src/claude-coding-worker/driver.ts` (`agentEnvironment` call site; add optional `cacheRoot` to `ClaudeWorkerRunOptions`, default `/workspace/.cache`)
- Test: `src/coding-worker/driver.test.ts`, `src/claude-coding-worker/driver.test.ts`

**Interfaces:**

- Consumes: `registryWorkerSetup` (Task 5).
- Produces: the agent's environment includes the registry variables; files are written before the agent starts.

- [ ] **Step 1: Write the failing tests**

In `src/coding-worker/driver.test.ts`, using the existing fake `createClient` that records its config:

```ts
it("points npm and pip at the proxy with the registry token, never the capability", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wardby-driver-"));
  const recorded: WorkerClientConfig[] = [];
  await runCodingWorker({
    ...baseOptions(),
    workspace,
    createClient: (config) => {
      recorded.push(config);
      return fakeClient();
    },
  });
  const env = recorded[0].environment;
  expect(env.npm_config_registry).toBe(`${baseOptions().proxyBaseUrl}/registry/npm/`);
  expect(env.PIP_INDEX_URL).toContain(deriveRegistryToken(baseOptions().capability));
  expect(JSON.stringify(env)).not.toContain(baseOptions().capability);
  expect(await readFile(join(workspace, ".cache", "npm", "npmrc"), "utf8")).toContain("_authToken=rrg_");
});
```

(Adapt `baseOptions()`/`fakeClient()` to the file's existing helpers.) Add the equivalent test to the Claude driver test, passing `cacheRoot` pointing at a temporary directory.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/coding-worker/driver.test.ts src/claude-coding-worker/driver.test.ts`
Expected: FAIL.

- [ ] **Step 3: Apply the setup in both drivers**

In `src/coding-worker/driver.ts`, before `options.createClient(...)`:

```ts
const registry = registryWorkerSetup({
  proxyBaseUrl: options.proxyBaseUrl,
  capability: options.capability,
  cacheRoot: `${options.workspace}/.cache`,
});
for (const file of registry.files) {
  await mkdir(dirname(file.path), { recursive: true });
  await writeFile(file.path, file.content, { mode: file.mode });
}
```

and pass `environment: { ...workerEnvironment(), ...registry.env }`.

In `src/claude-coding-worker/driver.ts`, do the same with `cacheRoot: options.cacheRoot ?? "/workspace/.cache"` and merge `registry.env` into `agentEnvironment(...)`'s result (not into `relayEnvironment()`).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/coding-worker src/claude-coding-worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/coding-worker src/claude-coding-worker
git commit -m "feat(workers): configure npm and pip to use the coding proxy registry"
```

---

### Task 11: Report packages in `get_run` and the pull request

**Files:**

- Modify: `src/mcp/tools/runs.ts:44-66` (`get_run`)
- Modify: `src/providers/vcs/github.ts:28` (`PullRequestInput`), `:111-119` (`pullRequestBody`)
- Modify: `src/providers/vcs/types.ts:44` (`FinalizeChangesDetails`), `src/providers/vcs/git.ts:494-502` (pass-through)
- Modify: `src/providers/executor/container.ts` (load fetches before `finalizeChanges`), `src/providers/executor/composition.ts` (wire the loader)
- Test: `src/mcp/tools/runs.test.ts`, `src/providers/vcs/github.test.ts`, `src/providers/executor/container.test.ts`

**Interfaces:**

- Produces:
  - `PackageReport = { ecosystem: string; name: string; version: string }`, `PackageRefusal = { ecosystem: string; name: string; reason: string }`
  - `PullRequestInput.packages?: readonly PackageReport[]`, `PullRequestInput.packageRefusals?: readonly PackageRefusal[]` (same on `FinalizeChangesDetails`)
  - `ContainerExecutorOptions.registryReport?: (runId: string) => Promise<{ packages: PackageReport[]; packageRefusals: PackageRefusal[] }>`
  - `get_run` output fields `packages` and `packageRefusals` for coding runs.

- [ ] **Step 1: Write the failing tests**

In `src/providers/vcs/github.test.ts`:

```ts
it("adds a collapsed packages section with refusals to the pull request body", () => {
  const body = pullRequestBodyForTest({
    runId: "run-1",
    repository: "openai/example",
    baseRef: "main",
    headRef: "wardby/run-run-1",
    summary: "Added HeroUI.",
    packages: [
      { ecosystem: "npm", name: "@heroui/react", version: "3.2.6" },
      { ecosystem: "npm", name: "@heroui/react", version: "3.2.6" },
    ],
    packageRefusals: [{ ecosystem: "npm", name: "left-pad", reason: "wardby_package_not_allowed" }],
  });
  expect(body).toContain("<details>\n<summary>Packages installed during this run (1)</summary>");
  expect(body).toContain("- npm `@heroui/react@3.2.6`");
  expect(body).toContain("- npm `left-pad`: wardby_package_not_allowed");
});
```

(Export `pullRequestBody` as `pullRequestBodyForTest`, or test through the fake GitHub request body the file already inspects.)

In `src/mcp/tools/runs.test.ts`, seed `registryFetch` rows in the fake db for a coding run and assert `get_run` returns `packages` (served, deduplicated) and `packageRefusals`.

In `src/providers/executor/container.test.ts`, pass a `registryReport` stub and assert `vcs.finalizeChanges` received `packages` and `packageRefusals` in its details.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/providers/vcs/github.test.ts src/mcp/tools/runs.test.ts src/providers/executor/container.test.ts`
Expected: FAIL.

- [ ] **Step 3: Render the section**

In `github.ts`, extend `PullRequestInput` and `pullRequestBody`:

```ts
export interface PackageReport {
  ecosystem: string;
  name: string;
  version: string;
}
export interface PackageRefusal {
  ecosystem: string;
  name: string;
  reason: string;
}

// in pullRequestBody, after the tests section:
const packages = [
  ...new Map((input.packages ?? []).map((p) => [`${p.ecosystem}\0${p.name}\0${p.version}`, p])).values(),
];
const refusals = [
  ...new Map((input.packageRefusals ?? []).map((r) => [`${r.ecosystem}\0${r.name}\0${r.reason}`, r])).values(),
];
if (packages.length > 0 || refusals.length > 0) {
  const lines = [
    "<details>",
    `<summary>Packages installed during this run (${packages.length})</summary>`,
    "",
    ...packages.map((p) => `- ${p.ecosystem} \`${p.name}@${p.version}\``),
    ...(refusals.length > 0
      ? ["", "**Refused:**", ...refusals.map((r) => `- ${r.ecosystem} \`${r.name}\`: ${r.reason}`)]
      : []),
    "</details>",
  ];
  sections.push(lines.join("\n"));
}
```

Add the same two optional fields to `FinalizeChangesDetails` and pass them through in `git.ts`'s `createOrFindDraftPullRequest({ ... })` call.

- [ ] **Step 4: Load and pass the report**

In `container.ts`, before calling `this.options.vcs.finalizeChanges(workspace, details)`:

```ts
const report = (await this.options.registryReport?.(run.runId).catch(() => undefined)) ?? {
  packages: [],
  packageRefusals: [],
};
// ...then include report.packages and report.packageRefusals in the details object
```

In `composition.ts`, wire:

```ts
      registryReport: async (runId) => {
        const rows = await db.registryFetch.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });
        return {
          packages: rows
            .filter((row) => row.outcome === "served" && row.version)
            .map((row) => ({ ecosystem: row.ecosystem, name: row.name, version: row.version! })),
          packageRefusals: rows
            .filter((row) => row.outcome === "refused")
            .map((row) => ({ ecosystem: row.ecosystem, name: row.name, reason: row.reason ?? "refused" })),
        };
      },
```

In `runs.ts` `get_run`, when `codingRun` exists, run the same query and add `packages` and `packageRefusals` to the result (deduplicated as above).

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/providers/vcs src/mcp/tools src/providers/executor`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/providers/vcs src/mcp/tools src/providers/executor
git commit -m "feat(registry): report installed and refused packages in get_run and the PR"
```

---

### Task 12: Proxy memory, documentation, spec amendments, and full verification

**Files:**

- Modify: `deploy/kind-coding/manifests/base/proxy.yaml` (memory `256Mi` → `512Mi` in requests and limits)
- Create: `docs/coding-packages.md`
- Modify: `docs/coding-worker-isolation.md`, `docs/security-deployment.md`, `docs/getting-started-identity-provider.md`, `docs/README.md`
- Modify: `docs/superpowers/specs/2026-09-25-coding-package-registry-design.md` (record the four amendments)

- [ ] **Step 1: Raise the proxy's memory**

In `proxy.yaml`, change the proxy container's `memory: 256Mi` values to `512Mi`, and add a comment: `# Streams package downloads for the coding registry.`

- [ ] **Step 2: Write `docs/coding-packages.md`**

Cover, in plain prose with one example each:

- enabling packages on an agent: `update_agent` with `codingProfile.packageAllowlist` (needs `packages:approve` or `agents:admin`), with the npm and PyPI entry syntax and scope wildcards;
- what the agent can then run (`npm install`, `pip install` into `.venv`), and that installs and caches are never collected;
- the safeguards: dependency graph only, 3-day minimum age and `packagePolicy.minReleaseAgeDays`, the OSV audit and `REGISTRY_AUDIT_FAIL_OPEN`, wheels only, and that npm install scripts are off by configuration but not enforced;
- the operator limits and their env settings;
- what the reviewer sees (the PR's packages section, `get_run.packages`);
- every error code with what to do about it;
- adding an ecosystem (point to the spec's §5 checklist).

- [ ] **Step 3: Update the other docs**

- `getting-started-identity-provider.md`: add `packages:approve` to the scope table ("Approve coding agents' package allowlists"), and change "Define all nine" to "Define all ten".
- `coding-worker-isolation.md`: in the network description, add that the proxy also serves the package registry on the same port with the registry-only token; link `coding-packages.md`.
- `security-deployment.md`: add the registry's upstream hosts to the proxy egress description, the npm install-script limit, and the fail-closed audit.
- `docs/README.md`: link `coding-packages.md`.

- [ ] **Step 4: Record the spec amendments**

Add a section "Amendments during planning" to the spec listing the four amendments from this plan's header, and update §2's worker-environment table to use the registry token.

- [ ] **Step 5: Full verification**

Run: `npm run lint && npm run format:check && npm run build && npm test`
Expected: all pass.
Run the drift check from `CLAUDE.md`; expected empty.

- [ ] **Step 6: Commit**

```bash
git add deploy docs
git commit -m "docs: coding package registry, packages:approve scope, and proxy memory"
```

---

### Task 13: Live acceptance on GKE (manual, after merge and rollout)

**Prerequisites:** Plan A and this plan merged; a `driver-vN` published from the merge commit and pinned (see the knock-knock pipeline notes); runtime and worker images rebuilt and rolled out; migrations applied.

- [ ] **Step 1:** Using MCP with `packages:approve`, update `knockknock-builder`: set `codingProfile.workerImageRef` to `null` (back to Wardby's `node-python` image) and `packageAllowlist` to `{ "npm": ["@heroui/react@^3", "react@^19", "react-dom@^19", "react-router@^7", "@tailwindcss/vite", "tailwindcss@^4", "vite", "@vitejs/plugin-react", "typescript", "vitest", "@testing-library/*", "jsdom"], "pypi": ["flask>=3", "pytest", "ruff"] }`.
- [ ] **Step 2:** Open a small knock-knock issue that needs a new npm dependency and trigger it with `@knock-knock-delivery`.
- [ ] **Step 3:** Confirm: the run succeeds; the PR body's "Packages installed during this run" lists the packages; `get_run` shows `packages`; no custom image was used; CI is green.
- [ ] **Step 4:** Trigger a request that needs a package outside the allowlist and confirm the agent's summary names `wardby_package_not_allowed` and the package.

---

### Task 14: Drop `allowedEgress` (separate release, after Task 13)

**Files:**

- Modify: `prisma/schema.prisma` (remove both `allowedEgress` columns)
- Create: `prisma/migrations/<timestamp>_drop_allowed_egress/migration.sql`

- [ ] **Step 1:** Confirm the release from this plan is fully rolled out (no pod runs an image older than Task 1's commit).
- [ ] **Step 2:** Remove both `allowedEgress` lines from `schema.prisma` and write:

```sql
-- allowedEgress has not been read or written since the package-registry release.

-- AlterTable
ALTER TABLE "CodingAgentProfile" DROP COLUMN "allowedEgress";

-- AlterTable
ALTER TABLE "CodingRun" DROP COLUMN "allowedEgress";
```

- [ ] **Step 3:** `npm run prisma:generate`, drift check (empty), `npm test`.
- [ ] **Step 4:** Commit: `git commit -m "chore(db): drop the unused allowedEgress columns"`.

---

## Self-review notes

- Spec coverage: §1 fields, scope, snapshot, data, proxy memory (Tasks 1, 5, 7, 12); §2 flow and worker env (Tasks 3, 4, 8, 9, 10); §3 safeguards, limits, errors, visibility (Tasks 6, 8, 11); §5 adapters (Tasks 2–5); §6 testing (every task; real clients in Task 9; live in Task 13); §7 docs (Task 12); §4 collection is Plan A.
- Amendments are listed in this plan's header and recorded in the spec in Task 12.
- Type names used across tasks: `RegistryAdapter`, `RegistryError`, `UpstreamFetch` (with `method`, `body`, `accept`, `signal`), `PackageAllowlist`, `resolvePolicy`, `matchRoot`, `parseAllowlist`, `REGISTRY_ADAPTERS`, `deriveRegistryToken`, `registryWorkerSetup`, `OsvAudit`, `RegistryStore`, `MemoryRegistryStore`, `PrismaRegistryStore`, `RegistryService`, `RegistryResponse`, `PackageReport`, `PackageRefusal` — each defined once, in the task named.
