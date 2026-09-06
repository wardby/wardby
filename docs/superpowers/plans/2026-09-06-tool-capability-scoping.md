# Per-Tool Capability Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Excessive Agency (OWASP LLM08) finding from the 2026-09-06 reevo-run code review — any tool attached to an agent currently has unscoped access to *every* secret and datastore key the agent has, plus unrestricted outbound `fetch`. This plan adds per-tool capability declarations (which secrets, which datastore key prefixes, which fetch hosts) at `attach_tool` time, persisted on `AgentTool`, and enforced at the sandbox bridge layer.

**Architecture:** A new validation module (`src/sandbox/tool-capabilities.ts`) defines the zod schema and bounded-array conventions for the three capability lists, mirroring the existing `src/coding/profile.ts` pattern (bounded `Json` columns, not native Postgres arrays — this repo's established convention for this kind of config). Two small wrapper functions — `scopeSecretsAccessor` (in `core/secrets.ts`) and `scopeDatastore` (new `providers/datastore/scoped.ts`) — decorate the existing `SecretsAccessor`/`Datastore` interfaces with an allowlist check, so `host-functions.ts`'s bridge functions need no changes for secrets/datastore. Fetch scoping is threaded as a new `allowedFetchHosts` option through `runInSandbox` → `installHostFunctions`, reusing `fetch-policy.ts`'s existing SSRF machinery via one new `restrictToAllowedHosts` flag. `runner.ts` builds these three scoped values per attached tool, from the `AgentTool` row's declared capabilities, immediately before each sandbox invocation.

**Tech Stack:** TypeScript, Prisma 6 + PostgreSQL, Zod, Vitest.

**Spec:** No standalone spec doc — this plan implements the fix direction from the 2026-09-06 codebase-review-agent run (runId `cmtq7dixx0002sqn0thy7d4wc`), memorialized in the user's `reevo-run-code-review-findings` memory: *"Needs per-tool capability scoping (which secrets/datastore prefixes/hosts a tool may touch, declared at attach time) enforced at the bridge layer."*

## Global Constraints

- **Backfill policy (user-confirmed):** every `AgentTool` row that exists before this migration ships must keep its current, unrestricted access after the migration runs (`allowedSecrets` = the agent's full current secret set, `allowedDatastorePrefixes` = `[""]`, `allowedHosts` = `["*"]`). Only `attach_tool`/CLI `tool attach` calls made **after** this ships default to empty (deny-all) when the caller doesn't declare capabilities. No scheduled agent may break on deploy day.
- **CLAUDE.md Prisma rules are strict:** migrations are hand-written, additive only, and the drift check (`prisma migrate diff` against an empty shadow DB) must come back as `-- This is an empty migration.` before this is done. Run it after Task 1 and again at the end (Task 8).
- Follow the existing `Json`-column-plus-zod-schema convention for bounded list-like config (`src/coding/profile.ts`), not a native Postgres array column — nothing else in this schema uses `String[]`.
- Every new/changed file gets tests in the same task that changes it; no task is "done" until its own tests pass.

---

## Task 1: Capability schema module + `AgentTool` migration

**Files:**
- Create: `src/sandbox/tool-capabilities.ts`
- Create: `src/sandbox/tool-capabilities.test.ts`
- Modify: `prisma/schema.prisma` (`AgentTool` model, ~line 95-102)
- Create: `prisma/migrations/20260906060000_tool_capability_scoping/migration.sql`

**Interfaces:**
- Produces: `ToolCapabilitiesSchema` (full, all fields defaulted to `[]`), `ToolCapabilitiesPatchSchema` (all fields optional, for partial re-declaration on re-attach), `FETCH_WILDCARD = "*"`, `asStringArray(value: unknown): string[]`, and the constants `MAX_ALLOWED_SECRETS`, `MAX_ALLOWED_DATASTORE_PREFIXES`, `MAX_ALLOWED_HOSTS` (each `64`). Later tasks (5, 6, 7) import all of these.
- Consumes: `normalizeHost` from `./fetch-policy.js` (already exists, unchanged).

- [ ] **Step 1: Write `src/sandbox/tool-capabilities.ts`**

```ts
/**
 * Per-attachment capability scoping for sandboxed tools (OWASP LLM08 —
 * Excessive Agency fix): which secrets, datastore key prefixes, and fetch
 * hosts a tool may touch, declared once at `attach_tool` time and persisted
 * as `Json` on `AgentTool`. Mirrors the coding-agent profile's own
 * bounded-array + zod-schema convention (`src/coding/profile.ts`) rather
 * than a native Postgres array column.
 */
import { z } from "zod";
import { normalizeHost } from "./fetch-policy.js";

export const MAX_ALLOWED_SECRETS = 64;
export const MAX_ALLOWED_DATASTORE_PREFIXES = 64;
export const MAX_ALLOWED_HOSTS = 64;

const MAX_SECRET_NAME_BYTES = 1024;
const MAX_DATASTORE_PREFIX_BYTES = 1024;

/** Element that lifts the fetch allowlist entirely for a tool (existing SSRF protection against private/link-local addresses still applies). */
export const FETCH_WILDCARD = "*";

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isValidHostToken(value: string): boolean {
  if (value === FETCH_WILDCARD) return true;
  try {
    normalizeHost(value);
    return true;
  } catch {
    return false;
  }
}

const secretNameSchema = z
  .string()
  .refine((v) => byteLength(v) <= MAX_SECRET_NAME_BYTES, `must be at most ${MAX_SECRET_NAME_BYTES} UTF-8 bytes`);

const datastorePrefixSchema = z
  .string()
  .refine((v) => byteLength(v) <= MAX_DATASTORE_PREFIX_BYTES, `must be at most ${MAX_DATASTORE_PREFIX_BYTES} UTF-8 bytes`);

const fetchHostSchema = z
  .string()
  .refine(isValidHostToken, `must be "${FETCH_WILDCARD}" or a normalizable hostname`)
  .transform((v) => (v === FETCH_WILDCARD ? FETCH_WILDCARD : normalizeHost(v)));

const toolCapabilityFields = {
  allowedSecrets: z.array(secretNameSchema).max(MAX_ALLOWED_SECRETS).transform((v) => [...new Set(v)]),
  allowedDatastorePrefixes: z.array(datastorePrefixSchema).max(MAX_ALLOWED_DATASTORE_PREFIXES).transform((v) => [...new Set(v)]),
  allowedHosts: z.array(fetchHostSchema).max(MAX_ALLOWED_HOSTS).transform((v) => [...new Set(v)]),
};

/** Full capability set — used when creating a brand-new attachment (unset fields default to deny-all). */
export const ToolCapabilitiesSchema = z
  .object({
    allowedSecrets: toolCapabilityFields.allowedSecrets.default([]),
    allowedDatastorePrefixes: toolCapabilityFields.allowedDatastorePrefixes.default([]),
    allowedHosts: toolCapabilityFields.allowedHosts.default([]),
  })
  .strict();

/** Partial capability set — used when re-declaring capabilities on an attachment that already exists; an omitted field leaves that field untouched. */
export const ToolCapabilitiesPatchSchema = z
  .object({
    allowedSecrets: toolCapabilityFields.allowedSecrets.optional(),
    allowedDatastorePrefixes: toolCapabilityFields.allowedDatastorePrefixes.optional(),
    allowedHosts: toolCapabilityFields.allowedHosts.optional(),
  })
  .strict();

export type ToolCapabilities = z.infer<typeof ToolCapabilitiesSchema>;
export type ToolCapabilitiesPatch = z.infer<typeof ToolCapabilitiesPatchSchema>;

/**
 * Coerces a Prisma `Json` column back into a string[]. Only
 * `ToolCapabilitiesSchema`-validated data is ever written to these columns,
 * but a DB read is never trusted blindly — malformed/foreign data degrades
 * to "no capability" rather than throwing mid-run.
 */
export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/sandbox/tool-capabilities.test.ts
import { describe, expect, it } from "vitest";
import {
  ToolCapabilitiesSchema,
  ToolCapabilitiesPatchSchema,
  asStringArray,
  FETCH_WILDCARD,
  MAX_ALLOWED_HOSTS,
} from "./tool-capabilities.js";

describe("ToolCapabilitiesSchema", () => {
  it("defaults every field to an empty (deny-all) array", () => {
    const result = ToolCapabilitiesSchema.parse({});
    expect(result).toEqual({ allowedSecrets: [], allowedDatastorePrefixes: [], allowedHosts: [] });
  });

  it("accepts the fetch wildcard alongside normalized hostnames, deduplicated", () => {
    const result = ToolCapabilitiesSchema.parse({
      allowedHosts: ["API.EXAMPLE.COM", "*", "api.example.com."],
    });
    expect(result.allowedHosts.sort()).toEqual([FETCH_WILDCARD, "api.example.com"]);
  });

  it("rejects an unnormalizable host", () => {
    expect(() => ToolCapabilitiesSchema.parse({ allowedHosts: ["not a host!"] })).toThrow();
  });

  it("rejects more than the max allowed hosts", () => {
    const hosts = Array.from({ length: MAX_ALLOWED_HOSTS + 1 }, (_, i) => `host${i}.example.com`);
    expect(() => ToolCapabilitiesSchema.parse({ allowedHosts: hosts })).toThrow();
  });

  it("accepts an empty-string datastore prefix (matches every key)", () => {
    const result = ToolCapabilitiesSchema.parse({ allowedDatastorePrefixes: [""] });
    expect(result.allowedDatastorePrefixes).toEqual([""]);
  });

  it("rejects unknown fields", () => {
    expect(() => ToolCapabilitiesSchema.parse({ nope: true })).toThrow();
  });
});

describe("ToolCapabilitiesPatchSchema", () => {
  it("leaves every field undefined when nothing is passed", () => {
    const result = ToolCapabilitiesPatchSchema.parse({});
    expect(result).toEqual({});
  });

  it("validates only the fields that are present", () => {
    const result = ToolCapabilitiesPatchSchema.parse({ allowedSecrets: ["API_KEY"] });
    expect(result).toEqual({ allowedSecrets: ["API_KEY"] });
  });
});

describe("asStringArray", () => {
  it("passes through a string array", () => {
    expect(asStringArray(["a", "b"])).toEqual(["a", "b"]);
  });
  it("drops non-string elements", () => {
    expect(asStringArray(["a", 1, null, "b"])).toEqual(["a", "b"]);
  });
  it("returns [] for null, undefined, objects, and non-array Json", () => {
    expect(asStringArray(null)).toEqual([]);
    expect(asStringArray(undefined)).toEqual([]);
    expect(asStringArray({})).toEqual([]);
    expect(asStringArray("not-an-array")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `npx vitest run src/sandbox/tool-capabilities.test.ts`
Expected: FAIL — `./tool-capabilities.js` does not exist yet.

- [ ] **Step 4: Confirm the module (Step 1) makes the tests pass**

Run: `npx vitest run src/sandbox/tool-capabilities.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Update `prisma/schema.prisma`'s `AgentTool` model**

Find (around line 94-102):

```prisma
/// Phase 3: explicit many-to-many join between Agent and Tool.
model AgentTool {
  agentId String
  toolId  String
  agent   Agent  @relation(fields: [agentId], references: [id])
  tool    Tool   @relation(fields: [toolId], references: [id])

  @@id([agentId, toolId])
}
```

Replace with:

```prisma
/// Phase 3: explicit many-to-many join between Agent and Tool.
/// Phase 6: per-attachment capability scoping (OWASP LLM08 fix — Excessive
/// Agency). Empty array = no access to that resource class; a tool must be
/// explicitly granted secrets/datastore-prefixes/hosts at attach time. A
/// literal "*" element in allowedHosts lifts the fetch allowlist entirely
/// (existing SSRF protection against private/link-local addresses still
/// applies) — the back-compat escape hatch for pre-existing attachments and
/// deliberate full-web-access tools. See src/sandbox/tool-capabilities.ts.
model AgentTool {
  agentId String
  toolId  String
  agent   Agent  @relation(fields: [agentId], references: [id])
  tool    Tool   @relation(fields: [toolId], references: [id])

  allowedSecrets           Json @default("[]")
  allowedDatastorePrefixes Json @default("[]")
  allowedHosts             Json @default("[]")

  @@id([agentId, toolId])
}
```

- [ ] **Step 6: Hand-write the migration**

Create `prisma/migrations/20260906060000_tool_capability_scoping/migration.sql`:

```sql
-- Per-attachment capability scoping (OWASP LLM08 fix). Additive: three new
-- JSONB columns on AgentTool, defaulting to an empty array (deny-all) for
-- any row inserted from now on. Pre-existing rows are explicitly backfilled
-- below to their current unrestricted behavior so no already-scheduled
-- agent breaks on deploy — new attach_tool/CLI calls default to deny-all.
BEGIN;

ALTER TABLE "AgentTool" ADD COLUMN "allowedSecrets" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "AgentTool" ADD COLUMN "allowedDatastorePrefixes" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "AgentTool" ADD COLUMN "allowedHosts" JSONB NOT NULL DEFAULT '[]';

UPDATE "AgentTool" AS at
SET "allowedSecrets" = COALESCE((
      SELECT jsonb_agg(s."name")
      FROM "AgentSecret" ags
      JOIN "Secret" s ON s."id" = ags."secretId"
      WHERE ags."agentId" = at."agentId"
    ), '[]'::jsonb),
    "allowedDatastorePrefixes" = '[""]'::jsonb,
    "allowedHosts" = '["*"]'::jsonb;

COMMIT;
```

- [ ] **Step 7: Apply locally and regenerate the client**

Run:
```bash
npm run db:up
npx prisma migrate resolve --applied 20260906060000_tool_capability_scoping
npm run prisma:generate
```
(If the local DB doesn't yet have every prior migration applied, run `npm run prisma:migrate` first — it's `prisma migrate deploy`, safe to run repeatedly.)

- [ ] **Step 8: Run the required drift check (CLAUDE.md)**

Run:
```bash
docker exec local-postgres-1 psql -U reevo -d reevo \
  -c "DROP DATABASE IF EXISTS reevo_shadow;" -c "CREATE DATABASE reevo_shadow;"
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "postgresql://reevo:reevo@localhost:55432/reevo_shadow" \
  --script
docker exec local-postgres-1 psql -U reevo -d reevo -c "DROP DATABASE IF EXISTS reevo_shadow;"
npx prisma validate
```
Expected: the diff script prints exactly `-- This is an empty migration.` If it prints any `ALTER`/`CREATE`, the `@default("[]")` syntax in schema.prisma doesn't match the migration's `DEFAULT '[]'` — adjust schema.prisma's default expression (not the migration) until this is clean.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260906060000_tool_capability_scoping src/sandbox/tool-capabilities.ts src/sandbox/tool-capabilities.test.ts
git commit -m "feat(sandbox): add per-tool capability schema + AgentTool migration"
```

---

## Task 2: Secrets scoping wrapper

**Files:**
- Modify: `src/core/secrets.ts`
- Modify: `src/core/secrets.test.ts`

**Interfaces:**
- Consumes: `SecretsAccessor` (already defined in `secrets.ts`).
- Produces: `scopeSecretsAccessor(accessor: SecretsAccessor, allowedNames: readonly string[]): SecretsAccessor` — Task 5 (runner.ts) calls this per tool invocation.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/secrets.test.ts` (check the file's existing imports first — add `scopeSecretsAccessor` to whatever import line already pulls from `./secrets.js`):

```ts
describe("scopeSecretsAccessor", () => {
  function fakeAccessor(values: Record<string, string>) {
    return { async get(name: string) { return values[name]; } };
  }

  it("resolves a name that is in the allowlist", async () => {
    const scoped = scopeSecretsAccessor(fakeAccessor({ ALLOWED: "v1", BLOCKED: "v2" }), ["ALLOWED"]);
    await expect(scoped.get("ALLOWED")).resolves.toBe("v1");
  });

  it("resolves undefined for a name that exists on the underlying accessor but is not in the allowlist", async () => {
    const scoped = scopeSecretsAccessor(fakeAccessor({ ALLOWED: "v1", BLOCKED: "v2" }), ["ALLOWED"]);
    await expect(scoped.get("BLOCKED")).resolves.toBeUndefined();
  });

  it("never calls the underlying accessor for a disallowed name", async () => {
    let calls = 0;
    const accessor = { async get(name: string) { calls++; return "x"; } };
    const scoped = scopeSecretsAccessor(accessor, []);
    await scoped.get("ANYTHING");
    expect(calls).toBe(0);
  });

  it("resolves undefined for every name when the allowlist is empty", async () => {
    const scoped = scopeSecretsAccessor(fakeAccessor({ A: "1" }), []);
    await expect(scoped.get("A")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/secrets.test.ts`
Expected: FAIL — `scopeSecretsAccessor` is not exported.

- [ ] **Step 3: Add `scopeSecretsAccessor` to `src/core/secrets.ts`**

Append to the end of the file:

```ts
/**
 * Wraps a `SecretsAccessor` so `get()` only ever resolves a name the caller
 * has declared this specific tool attachment may read — every other name
 * behaves exactly like one that was never attached (`undefined`), never a
 * throw, matching the existing "unattached name" convention. The underlying
 * accessor is never even called for a disallowed name.
 */
export function scopeSecretsAccessor(accessor: SecretsAccessor, allowedNames: readonly string[]): SecretsAccessor {
  const allowed = new Set(allowedNames);
  return {
    async get(name: string): Promise<string | undefined> {
      if (!allowed.has(name)) return undefined;
      return accessor.get(name);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/secrets.test.ts`
Expected: PASS (all existing tests plus the 4 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/core/secrets.ts src/core/secrets.test.ts
git commit -m "feat(core): add scopeSecretsAccessor for per-tool secret scoping"
```

---

## Task 3: Datastore scoping wrapper

**Files:**
- Create: `src/providers/datastore/scoped.ts`
- Create: `src/providers/datastore/scoped.test.ts`

**Interfaces:**
- Consumes: `Datastore`, `DatastoreValue` from `./types.js`.
- Produces: `scopeDatastore(datastore: Datastore, allowedPrefixes: readonly string[]): Datastore` — Task 5 (runner.ts) calls this per tool invocation.

- [ ] **Step 1: Write the failing tests**

```ts
// src/providers/datastore/scoped.test.ts
import { describe, expect, it } from "vitest";
import type { Datastore, DatastoreValue } from "./types.js";
import { scopeDatastore } from "./scoped.js";

function fakeDatastore(): Datastore {
  const store = new Map<string, DatastoreValue>();
  return {
    async get(agentId, key) { return store.get(`${agentId}:${key}`); },
    async set(agentId, key, value) { store.set(`${agentId}:${key}`, value); },
    async delete(agentId, key) { store.delete(`${agentId}:${key}`); },
    async list(agentId, prefix) {
      const p = `${agentId}:${prefix ?? ""}`;
      return [...store.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(agentId.length + 1));
    },
  };
}

describe("scopeDatastore", () => {
  it("get/set/delete/list all work normally for a key under an allowed prefix", async () => {
    const scoped = scopeDatastore(fakeDatastore(), ["allowed:"]);
    await scoped.set("a1", "allowed:1", "v");
    await expect(scoped.get("a1", "allowed:1")).resolves.toBe("v");
    expect(await scoped.list("a1")).toEqual(["allowed:1"]);
    await scoped.delete("a1", "allowed:1");
    await expect(scoped.get("a1", "allowed:1")).resolves.toBeUndefined();
  });

  it("get resolves undefined for a key outside every allowed prefix", async () => {
    const inner = fakeDatastore();
    await inner.set("a1", "blocked:1", "v");
    const scoped = scopeDatastore(inner, ["allowed:"]);
    await expect(scoped.get("a1", "blocked:1")).resolves.toBeUndefined();
  });

  it("set throws for a key outside every allowed prefix, and never reaches the underlying store", async () => {
    const inner = fakeDatastore();
    const scoped = scopeDatastore(inner, ["allowed:"]);
    await expect(scoped.set("a1", "blocked:1", "v")).rejects.toThrow("datastore_prefix_not_allowed");
    await expect(inner.get("a1", "blocked:1")).resolves.toBeUndefined();
  });

  it("delete on a disallowed key is a no-op rather than a throw", async () => {
    const inner = fakeDatastore();
    await inner.set("a1", "blocked:1", "v");
    const scoped = scopeDatastore(inner, ["allowed:"]);
    await scoped.delete("a1", "blocked:1");
    await expect(inner.get("a1", "blocked:1")).resolves.toBe("v");
  });

  it("list filters out keys outside every allowed prefix, even when the caller passes an unrestricted prefix filter", async () => {
    const inner = fakeDatastore();
    await inner.set("a1", "allowed:1", "v1");
    await inner.set("a1", "blocked:1", "v2");
    const scoped = scopeDatastore(inner, ["allowed:"]);
    expect(await scoped.list("a1")).toEqual(["allowed:1"]);
  });

  it("an empty-string prefix in the allowlist matches every key", async () => {
    const inner = fakeDatastore();
    const scoped = scopeDatastore(inner, [""]);
    await scoped.set("a1", "anything", "v");
    await expect(scoped.get("a1", "anything")).resolves.toBe("v");
  });

  it("an empty allowlist denies every read, write, and delete", async () => {
    const inner = fakeDatastore();
    await inner.set("a1", "x", "v");
    const scoped = scopeDatastore(inner, []);
    await expect(scoped.get("a1", "x")).resolves.toBeUndefined();
    await expect(scoped.set("a1", "x", "v2")).rejects.toThrow("datastore_prefix_not_allowed");
    expect(await scoped.list("a1")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/providers/datastore/scoped.test.ts`
Expected: FAIL — `./scoped.js` does not exist.

- [ ] **Step 3: Write `src/providers/datastore/scoped.ts`**

```ts
/**
 * Wraps a `Datastore` so every operation is confined to keys under one of
 * the tool attachment's declared prefixes (OWASP LLM08 — Excessive Agency
 * fix). Reads/lists on a disallowed key behave like the key doesn't exist
 * (consistent with a plain cache-miss); a write outside every allowed
 * prefix throws loudly instead — a tool author needs to know their write
 * was rejected, not silently believe it landed.
 */
import type { Datastore, DatastoreValue } from "./types.js";

function isAllowed(key: string, allowedPrefixes: readonly string[]): boolean {
  return allowedPrefixes.some((prefix) => key.startsWith(prefix));
}

export function scopeDatastore(datastore: Datastore, allowedPrefixes: readonly string[]): Datastore {
  return {
    async get(agentId: string, key: string): Promise<DatastoreValue | undefined> {
      if (!isAllowed(key, allowedPrefixes)) return undefined;
      return datastore.get(agentId, key);
    },
    async set(agentId: string, key: string, value: DatastoreValue): Promise<void> {
      if (!isAllowed(key, allowedPrefixes)) throw new Error("datastore_prefix_not_allowed");
      await datastore.set(agentId, key, value);
    },
    async delete(agentId: string, key: string): Promise<void> {
      if (!isAllowed(key, allowedPrefixes)) return;
      await datastore.delete(agentId, key);
    },
    async list(agentId: string, prefix?: string): Promise<string[]> {
      const keys = await datastore.list(agentId, prefix);
      return keys.filter((key) => isAllowed(key, allowedPrefixes));
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/providers/datastore/scoped.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/providers/datastore/scoped.ts src/providers/datastore/scoped.test.ts
git commit -m "feat(datastore): add scopeDatastore for per-tool key-prefix scoping"
```

---

## Task 4: Fetch host scoping

**Files:**
- Modify: `src/sandbox/fetch-policy.ts`
- Modify: `src/sandbox/fetch-policy.test.ts`
- Modify: `src/sandbox/host-functions.ts`
- Modify: `src/sandbox/host-functions.test.ts`
- Modify: `src/sandbox/run-in-sandbox.ts`
- Modify: `src/mcp/tools/tools.ts` (dry_run_tool only, in this task)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `FETCH_WILDCARD` from `./tool-capabilities.js` (Task 1).
- Produces: `FetchPolicyOptions.restrictToAllowedHosts`, `HostFunctionOptions.allowedFetchHosts`, `SandboxInvocation.allowedFetchHosts` — Task 5 (runner.ts) sets the last one per tool invocation.

- [ ] **Step 1: Write the failing `fetch-policy.ts` tests**

Add to `src/sandbox/fetch-policy.test.ts`:

```ts
describe("assertFetchDestinationAllowed (restrictToAllowedHosts)", () => {
  it("blocks a public host that is not on the allowlist when restricted", async () => {
    await expect(
      assertFetchDestinationAllowed("http://8.8.8.8/", { restrictToAllowedHosts: true }),
    ).rejects.toThrow(/blocked/);
  });

  it("allows a public host that is on the allowlist when restricted", async () => {
    await expect(
      assertFetchDestinationAllowed("http://8.8.8.8/", { allowedHosts: ["8.8.8.8"], restrictToAllowedHosts: true }),
    ).resolves.toBeUndefined();
  });

  it("still blocks a private address even when it is on the allowlist and unrestricted (no accidental widening)", async () => {
    await expect(
      assertFetchDestinationAllowed("http://8.8.8.8/", { allowedHosts: [], restrictToAllowedHosts: false }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify the first two fail**

Run: `npx vitest run src/sandbox/fetch-policy.test.ts`
Expected: the two `restrictToAllowedHosts` tests FAIL (option is silently ignored today, so neither request is blocked); the third passes already (documents present behavior, not a new assertion).

- [ ] **Step 3: Add `restrictToAllowedHosts` to `fetch-policy.ts`**

Change:
```ts
export interface FetchPolicyOptions { allowedHosts?: string[]; resolve?: Resolver; }
```
to:
```ts
export interface FetchPolicyOptions { allowedHosts?: string[]; resolve?: Resolver; restrictToAllowedHosts?: boolean; }
```

Change:
```ts
export async function resolveDestination(urlString: string, options: FetchPolicyOptions = {}) {
  let url: URL;
  try { url = new URL(urlString); } catch { throw new FetchPolicyError(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || urlString.length > 8192) throw new FetchPolicyError();
  const hostname = normalizeHost(url.hostname);
  const allowed = (options.allowedHosts ?? []).map(normalizeHost).includes(hostname);
  const version = isIP(hostname);
```
to:
```ts
export async function resolveDestination(urlString: string, options: FetchPolicyOptions = {}) {
  let url: URL;
  try { url = new URL(urlString); } catch { throw new FetchPolicyError(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || urlString.length > 8192) throw new FetchPolicyError();
  const hostname = normalizeHost(url.hostname);
  const allowed = (options.allowedHosts ?? []).map(normalizeHost).includes(hostname);
  if (options.restrictToAllowedHosts && !allowed) throw new FetchPolicyError();
  const version = isIP(hostname);
```

(The rest of the function — DNS resolution and the existing SSRF `isGlobalAddress` check — is unchanged, and runs for every redirect hop via `safeFetch`'s per-hop `resolveDestination(url, options)` call, so a restricted tool can't escape the allowlist through a redirect either.)

- [ ] **Step 4: Run to verify all three pass**

Run: `npx vitest run src/sandbox/fetch-policy.test.ts`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Write the failing `host-functions.ts` tests**

Add to `src/sandbox/host-functions.test.ts` (new top-level `describe`):

```ts
describe("__bridge_fetch host scoping", () => {
  it("blocks all outbound fetch when the tool has no declared allowedFetchHosts (deny by default)", async () => {
    const result = await runInSandbox({
      code: "return await fetch('http://8.8.8.8/');",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "fetcher",
    });
    expect(result).toMatchObject({ ok: false, errorMessage: expect.stringContaining("fetch_destination_blocked") });
  });

  it("still enforces SSRF protection against private addresses even with the wildcard host declared", async () => {
    const result = await runInSandbox({
      code: "return await fetch('http://169.254.169.254/');",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "fetcher",
      allowedFetchHosts: ["*"],
    });
    expect(result).toMatchObject({ ok: false, errorMessage: expect.stringContaining("fetch_destination_blocked") });
  });

  it("restricts fetch to exactly the tool's declared host allowlist", async () => {
    const result = await runInSandbox({
      code: "return await fetch('http://8.8.8.8/');",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "fetcher",
      allowedFetchHosts: ["example.com"],
    });
    expect(result).toMatchObject({ ok: false, errorMessage: expect.stringContaining("fetch_destination_blocked") });
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run src/sandbox/host-functions.test.ts`
Expected: FAIL — `runInSandbox` doesn't accept `allowedFetchHosts` yet, and today's `__bridge_fetch` ignores per-call scoping entirely (the first test would currently succeed in reaching the network / resolve without a block, since 8.8.8.8 is a global address and the global `FETCH_ALLOWED_HOSTS` allowlist is irrelevant to it).

- [ ] **Step 7: Wire `allowedFetchHosts` through `run-in-sandbox.ts`**

In `src/sandbox/run-in-sandbox.ts`, change the `SandboxInvocation` interface:
```ts
export interface SandboxInvocation {
  code: string;
  params: unknown;
  agentId: string;
  datastore: Datastore;
  toolName: string;
  limits?: Partial<SandboxLimits>;
  secrets?: SecretsAccessor;
  logger?: Logger;
}
```
to:
```ts
export interface SandboxInvocation {
  code: string;
  params: unknown;
  agentId: string;
  datastore: Datastore;
  toolName: string;
  limits?: Partial<SandboxLimits>;
  secrets?: SecretsAccessor;
  logger?: Logger;
  /** Forwarded to installHostFunctions — which hosts this tool attachment may fetch. Omitted/empty = no outbound fetch at all; a literal "*" element lifts the restriction. */
  allowedFetchHosts?: string[];
}
```

And change the `installHostFunctions` call:
```ts
  return evalToJson(code, invocation.limits, (context, runtime, signal) => {
    installHostFunctions(context, runtime, {
      agentId: invocation.agentId,
      datastore: invocation.datastore,
      logTag: invocation.toolName,
      secrets: invocation.secrets,
      logger: invocation.logger,
      signal,
    });
  });
```
to:
```ts
  return evalToJson(code, invocation.limits, (context, runtime, signal) => {
    installHostFunctions(context, runtime, {
      agentId: invocation.agentId,
      datastore: invocation.datastore,
      logTag: invocation.toolName,
      secrets: invocation.secrets,
      logger: invocation.logger,
      allowedFetchHosts: invocation.allowedFetchHosts,
      signal,
    });
  });
```

- [ ] **Step 8: Enforce it in `host-functions.ts`**

Add the import:
```ts
import { FETCH_WILDCARD } from "./tool-capabilities.js";
```

Change `HostFunctionOptions`:
```ts
export interface HostFunctionOptions {
  signal?: AbortSignal;
  agentId: string;
  datastore: Datastore;
  /** Tag prefixed onto forwarded console output — typically the tool name. */
  logTag: string;
  /** Omitted (e.g. dry_run_tool, no real agent) — secrets.get always resolves undefined. */
  secrets?: SecretsAccessor;
  /** Overrides the shared default logger — mainly for tests. */
  logger?: Logger;
}
```
to:
```ts
export interface HostFunctionOptions {
  signal?: AbortSignal;
  agentId: string;
  datastore: Datastore;
  /** Tag prefixed onto forwarded console output — typically the tool name. */
  logTag: string;
  /** Omitted (e.g. dry_run_tool, no real agent) — secrets.get always resolves undefined. */
  secrets?: SecretsAccessor;
  /** Overrides the shared default logger — mainly for tests. */
  logger?: Logger;
  /** Hosts this specific tool attachment may fetch. Omitted/empty = no outbound fetch at all; a literal "*" element lifts the restriction (existing SSRF protection against private/link-local addresses still applies). */
  allowedFetchHosts?: string[];
}
```

Change the destructure:
```ts
  const { agentId, datastore, logTag, secrets, signal } = options;
```
to:
```ts
  const { agentId, datastore, logTag, secrets, signal, allowedFetchHosts } = options;
```

Change `__bridge_fetch`:
```ts
  register("__bridge_fetch", async (argsJson) => {
    const [url, init] = args<[string, { method?: string; headers?: Record<string, string>; body?: string }]>(
      argsJson,
    );
    return safeFetch(url, init, { allowedHosts: FETCH_ALLOWED_HOSTS, signal });
  });
```
to:
```ts
  register("__bridge_fetch", async (argsJson) => {
    const [url, init] = args<[string, { method?: string; headers?: Record<string, string>; body?: string }]>(
      argsJson,
    );
    const hosts = allowedFetchHosts ?? [];
    if (hosts.includes(FETCH_WILDCARD)) {
      return safeFetch(url, init, { allowedHosts: FETCH_ALLOWED_HOSTS, signal });
    }
    return safeFetch(url, init, { allowedHosts: hosts, restrictToAllowedHosts: true, signal });
  });
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run src/sandbox/host-functions.test.ts src/sandbox/run-in-sandbox.test.ts`
Expected: PASS.

- [ ] **Step 10: Preserve `dry_run_tool`'s existing unrestricted-fetch behavior**

`dry_run_tool` (in `src/mcp/tools/tools.ts`) has no `AgentTool` row — it's the tool author's own pre-attach test sandbox, not a production agent run, so it should keep today's exact fetch behavior rather than silently becoming fetch-blocked.

Add the import in `src/mcp/tools/tools.ts`:
```ts
import { FETCH_WILDCARD } from "../../sandbox/tool-capabilities.js";
```

Change:
```ts
      const sandboxResult = await runInSandbox({
        code: args.code,
        params: validated.value,
        agentId: ctx.principal.id,
        datastore: ctx.providers.datastore as Datastore,
        toolName: "dry_run_tool",
      });
```
to:
```ts
      const sandboxResult = await runInSandbox({
        code: args.code,
        params: validated.value,
        agentId: ctx.principal.id,
        datastore: ctx.providers.datastore as Datastore,
        toolName: "dry_run_tool",
        allowedFetchHosts: [FETCH_WILDCARD],
      });
```

- [ ] **Step 11: Clarify `.env.example`**

Change:
```
# Exact normalized hosts only. Allowlisting private hosts bypasses network isolation.
REEVO_FETCH_ALLOWED_HOSTS=
```
to:
```
# Exact normalized hosts only. Allowlisting private hosts bypasses network isolation.
# Only takes effect for a tool attachment whose allowedHosts includes the "*"
# wildcard (attach_tool / CLI `tool attach`) — a tool with an explicit host
# list ignores this and is restricted to exactly what it declared.
REEVO_FETCH_ALLOWED_HOSTS=
```

- [ ] **Step 12: Run the full sandbox test suite**

Run: `npx vitest run src/sandbox src/mcp/tools/tools.test.ts`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add src/sandbox/fetch-policy.ts src/sandbox/fetch-policy.test.ts src/sandbox/host-functions.ts src/sandbox/host-functions.test.ts src/sandbox/run-in-sandbox.ts src/mcp/tools/tools.ts .env.example
git commit -m "feat(sandbox): scope outbound fetch to a tool's declared host allowlist"
```

---

## Task 5: Wire capability scoping into `runner.ts`

**Files:**
- Modify: `src/core/runner.ts`
- Modify: `src/core/runner.test.ts`

**Interfaces:**
- Consumes: `scopeSecretsAccessor` (Task 2), `scopeDatastore` (Task 3), `asStringArray` (Task 1). `db.agentTool.findMany` now returns rows carrying `allowedSecrets`/`allowedDatastorePrefixes`/`allowedHosts` as `Prisma.JsonValue` (Task 1's migration + `prisma generate`).
- Produces: nothing new for other tasks — this is the integration point.

- [ ] **Step 1: Write the failing tests**

First, extend `runner.test.ts`'s shared `fakeDb` helper to carry capability fields on attachments and to support looking up a real secret (needed to prove secrets scoping end-to-end through `buildSecretsAccessor`'s existing DB-fallback path). Replace:

```ts
function fakeDb(
  agents: FakeAgent[],
  tools: FakeTool[] = [],
  attachments: { agentId: string; toolId: string }[] = [],
): RunnerDb {
  const byName = new Map(agents.map((a) => [a.name, a]));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const toolsById = new Map(tools.map((t) => [t.id, t]));
  const runs = new Map<string, any>();
  let counter = 0;

  return {
    agent: {
      findUnique: (async ({ where }: any) =>
        (where.name ? byName.get(where.name) : byId.get(where.id)) ?? null) as any,
    },
    run: {
      create: (async ({ data }: any) => {
        const id = `run_${++counter}`;
        const record = {
          id,
          status: "pending",
          trigger: "manual",
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          error: null,
          startedAt: new Date(),
          finishedAt: null,
          heartbeatAt: null,
          ...data,
        };
        runs.set(id, record);
        return record;
      }) as any,
      findUnique: (async ({ where }: any) => runs.get(where.id) ?? null) as any,
      update: (async ({ where, data }: any) => {
        const record = { ...runs.get(where.id), ...data };
        runs.set(where.id, record);
        return record;
      }) as any,
    },
    agentTool: {
      findMany: (async ({ where }: any) =>
        attachments
          .filter((a) => a.agentId === where.agentId)
          .map((a) => ({ ...a, tool: toolsById.get(a.toolId) }))) as any,
    },
  } as unknown as RunnerDb;
}
```

with:

```ts
interface FakeAttachment {
  agentId: string;
  toolId: string;
  allowedSecrets?: string[];
  allowedDatastorePrefixes?: string[];
  allowedHosts?: string[];
}

function fakeDb(
  agents: FakeAgent[],
  tools: FakeTool[] = [],
  attachments: FakeAttachment[] = [],
  secretsData: { agentId: string; name: string; value: string }[] = [],
): RunnerDb {
  const byName = new Map(agents.map((a) => [a.name, a]));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const toolsById = new Map(tools.map((t) => [t.id, t]));
  const runs = new Map<string, any>();
  let counter = 0;

  return {
    agent: {
      findUnique: (async ({ where }: any) =>
        (where.name ? byName.get(where.name) : byId.get(where.id)) ?? null) as any,
    },
    run: {
      create: (async ({ data }: any) => {
        const id = `run_${++counter}`;
        const record = {
          id,
          status: "pending",
          trigger: "manual",
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          error: null,
          startedAt: new Date(),
          finishedAt: null,
          heartbeatAt: null,
          ...data,
        };
        runs.set(id, record);
        return record;
      }) as any,
      findUnique: (async ({ where }: any) => runs.get(where.id) ?? null) as any,
      update: (async ({ where, data }: any) => {
        const record = { ...runs.get(where.id), ...data };
        runs.set(where.id, record);
        return record;
      }) as any,
    },
    agentTool: {
      findMany: (async ({ where }: any) =>
        attachments
          .filter((a) => a.agentId === where.agentId)
          .map((a) => ({ ...a, tool: toolsById.get(a.toolId) }))) as any,
    },
    agentSecret: {
      findFirst: (async ({ where }: any) => {
        const row = secretsData.find((s) => s.agentId === where.agentId && s.name === where.secret.name);
        return row ? { secret: { ciphertext: row.value } } : null;
      }) as any,
    },
  } as unknown as RunnerDb;
}

function fakeCipher(): SecretCipher {
  return {
    keyId: () => "k1",
    encrypt: async (v: string) => v,
    decrypt: async (v: string) => v,
  } as unknown as SecretCipher;
}
```

Then add two new tests to the `describe("runAgent", ...)` block:

```ts
  it("scopes a sandboxed tool's datastore access to its declared allowedDatastorePrefixes", async () => {
    const db = fakeDb(
      [{ id: "a1", name: "scoped-ds", systemPrompt: "sys", model: "m", budgetUsd: 10, maxTurns: 10 }],
      [{
        id: "t1",
        name: "write_key",
        description: "x",
        paramsZod: "z.object({ key: z.string() })",
        jsonSchema: {},
        code: "await datastore.set(params.key, 'v'); return 'ok';",
      }],
      [{ agentId: "a1", toolId: "t1", allowedDatastorePrefixes: ["allowed:"] }],
    );
    let captured: EngineRunContext | undefined;
    const engine = fakeEngine(
      { status: "succeeded", finalText: "", turns: 1, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 } },
      (ctx) => { captured = ctx; },
    );

    await runAgent("scoped-ds", { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher }, db);

    const allowed = JSON.parse(await captured!.runSandboxTool("write_key", JSON.stringify({ key: "allowed:1" })));
    expect(allowed).toBe("ok");

    const blocked = JSON.parse(await captured!.runSandboxTool("write_key", JSON.stringify({ key: "blocked:1" })));
    expect(blocked).toMatchObject({ error: "thrown", message: expect.stringContaining("datastore_prefix_not_allowed") });
  });

  it("scopes a sandboxed tool's secrets access to its declared allowedSecrets", async () => {
    const db = fakeDb(
      [{ id: "a1", name: "scoped-secrets", systemPrompt: "sys", model: "m", budgetUsd: 10, maxTurns: 10 }],
      [{
        id: "t1",
        name: "read_secret",
        description: "x",
        paramsZod: "z.object({ name: z.string() })",
        jsonSchema: {},
        code: "const v = await secrets.get(params.name); return v === undefined ? null : v;",
      }],
      [{ agentId: "a1", toolId: "t1", allowedSecrets: ["ALLOWED"] }],
      [
        { agentId: "a1", name: "ALLOWED", value: "secret-a" },
        { agentId: "a1", name: "BLOCKED", value: "secret-b" },
      ],
    );
    let captured: EngineRunContext | undefined;
    const engine = fakeEngine(
      { status: "succeeded", finalText: "", turns: 1, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 } },
      (ctx) => { captured = ctx; },
    );

    await runAgent("scoped-secrets", { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: fakeCipher() }, db);

    const allowed = JSON.parse(await captured!.runSandboxTool("read_secret", JSON.stringify({ name: "ALLOWED" })));
    expect(allowed).toBe("secret-a");

    const blocked = JSON.parse(await captured!.runSandboxTool("read_secret", JSON.stringify({ name: "BLOCKED" })));
    expect(blocked).toBeNull();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/core/runner.test.ts`
Expected: FAIL — the datastore test's "blocked" write currently succeeds (no scoping yet, so `datastore.set` never throws); the secrets test's "blocked" read currently returns `"secret-b"` instead of `null` (no scoping yet).

- [ ] **Step 3: Wire scoping into `runner.ts`**

Add imports:
```ts
import { buildSecretsAccessor, scopeSecretsAccessor } from "./secrets.js";
import { scopeDatastore } from "../providers/datastore/scoped.js";
import { asStringArray } from "../sandbox/tool-capabilities.js";
```
(replacing the existing `import { buildSecretsAccessor } from "./secrets.js";` line.)

Change:
```ts
    const toolsByName = new Map(
      attached.map((attachment) => [
        attachment.tool.name,
        { code: attachment.tool.code, paramsZod: attachment.tool.paramsZod },
      ]),
    );
```
to:
```ts
    const toolsByName = new Map(
      attached.map((attachment) => [
        attachment.tool.name,
        {
          code: attachment.tool.code,
          paramsZod: attachment.tool.paramsZod,
          allowedSecrets: asStringArray(attachment.allowedSecrets),
          allowedDatastorePrefixes: asStringArray(attachment.allowedDatastorePrefixes),
          allowedHosts: asStringArray(attachment.allowedHosts),
        },
      ]),
    );
```

Change:
```ts
      const result = await runInSandbox({
        code: tool.code,
        params: validation.value,
        agentId: agent.id,
        datastore: providers.datastore,
        secrets: secretsAccessor,
        toolName: name,
      });
```
to:
```ts
      const result = await runInSandbox({
        code: tool.code,
        params: validation.value,
        agentId: agent.id,
        datastore: scopeDatastore(providers.datastore, tool.allowedDatastorePrefixes),
        secrets: scopeSecretsAccessor(secretsAccessor, tool.allowedSecrets),
        allowedFetchHosts: tool.allowedHosts,
        toolName: name,
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/runner.test.ts`
Expected: PASS (all existing tests — unaffected, since `asStringArray(undefined)` is `[]` and their tool bodies never touch secrets/datastore/fetch — plus the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/core/runner.ts src/core/runner.test.ts
git commit -m "feat(core): enforce per-tool capability scoping in the runner"
```

---

## Task 6: `attach_tool` accepts and persists capabilities

**Files:**
- Modify: `src/mcp/tools/tools.ts`
- Modify: `src/mcp/tools/tools.test.ts`
- Modify: `src/mcp/integration.test.ts`

**Interfaces:**
- Consumes: `ToolCapabilitiesPatchSchema` (Task 1).
- Produces: nothing new for other tasks — this is the authoring-time entry point that Task 7 (CLI) mirrors independently.

- [ ] **Step 1: Write the failing tests**

Add to `src/mcp/tools/tools.test.ts`. First add an `agentTool.upsert` mock — the current `fakeDb`'s `agentTool` only has `create`/`deleteMany`/`findMany`. Replace:

```ts
    agentTool: {
      create: async ({ data }: { data: { agentId: string; toolId: string } }) => {
        attachments.push(data);
        return data;
      },
      deleteMany: async ({ where }: { where: { agentId: string; toolId: string } }) => {
        const before = attachments.length;
        const kept = attachments.filter((a) => !(a.agentId === where.agentId && a.toolId === where.toolId));
        attachments.length = 0;
        attachments.push(...kept);
        return { count: before - kept.length };
      },
      findMany: async ({ where }: { where: { agentId: string } }) =>
        attachments.filter((a) => a.agentId === where.agentId).map((a) => ({ ...a, tool: toolRows.get(a.toolId) })),
    },
```

with:

```ts
    agentTool: {
      create: async ({ data }: { data: { agentId: string; toolId: string } }) => {
        attachments.push(data);
        return data;
      },
      upsert: async ({ where, create, update }: { where: { agentId_toolId: { agentId: string; toolId: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const idx = attachments.findIndex((a) => a.agentId === where.agentId_toolId.agentId && a.toolId === where.agentId_toolId.toolId);
        if (idx === -1) {
          const row = { agentId: where.agentId_toolId.agentId, toolId: where.agentId_toolId.toolId, allowedSecrets: [], allowedDatastorePrefixes: [], allowedHosts: [], ...create };
          attachments.push(row as never);
          return row;
        }
        attachments[idx] = { ...attachments[idx], ...update } as never;
        return attachments[idx];
      },
      deleteMany: async ({ where }: { where: { agentId: string; toolId: string } }) => {
        const before = attachments.length;
        const kept = attachments.filter((a) => !(a.agentId === where.agentId && a.toolId === where.toolId));
        attachments.length = 0;
        attachments.push(...kept);
        return { count: before - kept.length };
      },
      findMany: async ({ where }: { where: { agentId: string } }) =>
        attachments.filter((a) => a.agentId === where.agentId).map((a) => ({ ...a, tool: toolRows.get(a.toolId) })),
    },
```

Also widen the local `attachments` type declaration from:
```ts
  const attachments: { agentId: string; toolId: string }[] = [];
```
to:
```ts
  const attachments: Record<string, unknown>[] = [];
```

Then add new test cases in the `describe("tool authoring tools", ...)` block:

```ts
  it("attach_tool persists declared capabilities and rejects an invalid host", async () => {
    const db = fakeDb(
      [{ id: "t1", name: "greet", description: "x", paramsZod: "z.object({})", jsonSchema: {}, code: "", ownerId: "p1" }],
      [{ id: "a1", ownerId: "p1" }],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    const bad = await client.callTool({
      name: "attach_tool",
      arguments: { agentId: "a1", toolId: "t1", allowedHosts: ["not a host!"] },
    });
    expect(bad.isError).toBe(true);

    const attach = await client.callTool({
      name: "attach_tool",
      arguments: { agentId: "a1", toolId: "t1", allowedSecrets: ["API_KEY"], allowedHosts: ["api.example.com"] },
    });
    expect(attach.isError).toBeFalsy();

    const rows = await db.agentTool.findMany({ where: { agentId: "a1" } });
    expect(rows[0]).toMatchObject({ allowedSecrets: ["API_KEY"], allowedHosts: ["api.example.com"], allowedDatastorePrefixes: [] });
    await client.close();
  });

  it("attach_tool defaults to deny-all capabilities when none are declared", async () => {
    const db = fakeDb(
      [{ id: "t1", name: "greet", description: "x", paramsZod: "z.object({})", jsonSchema: {}, code: "", ownerId: "p1" }],
      [{ id: "a1", ownerId: "p1" }],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    await client.callTool({ name: "attach_tool", arguments: { agentId: "a1", toolId: "t1" } });
    const rows = await db.agentTool.findMany({ where: { agentId: "a1" } });
    expect(rows[0]).toMatchObject({ allowedSecrets: [], allowedDatastorePrefixes: [], allowedHosts: [] });
    await client.close();
  });

  it("re-attaching declares only the fields passed, leaving the rest untouched", async () => {
    const db = fakeDb(
      [{ id: "t1", name: "greet", description: "x", paramsZod: "z.object({})", jsonSchema: {}, code: "", ownerId: "p1" }],
      [{ id: "a1", ownerId: "p1" }],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    await client.callTool({ name: "attach_tool", arguments: { agentId: "a1", toolId: "t1", allowedSecrets: ["API_KEY"] } });
    await client.callTool({ name: "attach_tool", arguments: { agentId: "a1", toolId: "t1", allowedHosts: ["api.example.com"] } });

    const rows = await db.agentTool.findMany({ where: { agentId: "a1" } });
    expect(rows[0]).toMatchObject({ allowedSecrets: ["API_KEY"], allowedHosts: ["api.example.com"] });
    await client.close();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/mcp/tools/tools.test.ts`
Expected: FAIL — `attach_tool`'s input schema doesn't accept the new fields yet, and its handler doesn't validate or persist them.

- [ ] **Step 3: Update `attach_tool` in `src/mcp/tools/tools.ts`**

Add the import:
```ts
import { ToolCapabilitiesPatchSchema } from "../../sandbox/tool-capabilities.js";
```

Change:
```ts
  mcp.registerTool({
    name: "attach_tool",
    scope: "tools:write",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, toolId: { type: "string" } }, required: ["agentId", "toolId"] },
    handler: async (args: { agentId: string; toolId: string }, ctx) => {
      await ctx.db.$transaction(async (tx) => {
        const agent = await tx.agent.findUnique({ where: { id: args.agentId } });
        if (!agent) throw new McpError(404, `Agent "${args.agentId}" not found.`);
        assertCanMutate(agent.ownerId, ctx.principal.id, `Agent "${args.agentId}" is not owned by the caller.`);
        if (agent.kind === "coding") {
          throw new McpError(400, "Native sandbox tools cannot be attached to coding agents.");
        }
        await requireOwnedTool(tx, args.toolId, ctx.principal.id);
        await tx.agentTool.create({ data: { agentId: args.agentId, toolId: args.toolId } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return textResult({ attached: true });
    },
  });
```
to:
```ts
  mcp.registerTool({
    name: "attach_tool",
    scope: "tools:write",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        toolId: { type: "string" },
        allowedSecrets: { type: "array", items: { type: "string" } },
        allowedDatastorePrefixes: { type: "array", items: { type: "string" } },
        allowedHosts: { type: "array", items: { type: "string" } },
      },
      required: ["agentId", "toolId"],
    },
    handler: async (
      args: {
        agentId: string;
        toolId: string;
        allowedSecrets?: string[];
        allowedDatastorePrefixes?: string[];
        allowedHosts?: string[];
      },
      ctx,
    ) => {
      const patch = ToolCapabilitiesPatchSchema.safeParse({
        allowedSecrets: args.allowedSecrets,
        allowedDatastorePrefixes: args.allowedDatastorePrefixes,
        allowedHosts: args.allowedHosts,
      });
      if (!patch.success) {
        throw new McpError(400, `Invalid tool capabilities: ${patch.error.issues.map((i) => i.message).join("; ")}`);
      }
      await ctx.db.$transaction(async (tx) => {
        const agent = await tx.agent.findUnique({ where: { id: args.agentId } });
        if (!agent) throw new McpError(404, `Agent "${args.agentId}" not found.`);
        assertCanMutate(agent.ownerId, ctx.principal.id, `Agent "${args.agentId}" is not owned by the caller.`);
        if (agent.kind === "coding") {
          throw new McpError(400, "Native sandbox tools cannot be attached to coding agents.");
        }
        await requireOwnedTool(tx, args.toolId, ctx.principal.id);
        await tx.agentTool.upsert({
          where: { agentId_toolId: { agentId: args.agentId, toolId: args.toolId } },
          create: {
            agentId: args.agentId,
            toolId: args.toolId,
            allowedSecrets: patch.data.allowedSecrets ?? [],
            allowedDatastorePrefixes: patch.data.allowedDatastorePrefixes ?? [],
            allowedHosts: patch.data.allowedHosts ?? [],
          },
          update: {
            ...(patch.data.allowedSecrets !== undefined ? { allowedSecrets: patch.data.allowedSecrets } : {}),
            ...(patch.data.allowedDatastorePrefixes !== undefined ? { allowedDatastorePrefixes: patch.data.allowedDatastorePrefixes } : {}),
            ...(patch.data.allowedHosts !== undefined ? { allowedHosts: patch.data.allowedHosts } : {}),
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return textResult({ attached: true });
    },
  });
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/mcp/tools/tools.test.ts`
Expected: PASS (all existing tests plus the 3 new ones).

- [ ] **Step 5: Update `integration.test.ts`'s fake db the same way**

`src/mcp/integration.test.ts`'s `agentTool` mock (around line 201) needs the same `upsert` addition as Step 1 above (its `create`/`deleteMany`/`findMany` are identical in shape). Add:
```ts
      upsert: async ({ where, create, update }: { where: { agentId_toolId: { agentId: string; toolId: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const idx = agentTools.findIndex((a) => a.agentId === where.agentId_toolId.agentId && a.toolId === where.agentId_toolId.toolId);
        if (idx === -1) {
          const row = { agentId: where.agentId_toolId.agentId, toolId: where.agentId_toolId.toolId, allowedSecrets: [], allowedDatastorePrefixes: [], allowedHosts: [], ...create };
          agentTools.push(row as never);
          return row;
        }
        agentTools[idx] = { ...agentTools[idx], ...update } as never;
        return agentTools[idx];
      },
```
right after the `count` entry and before `create` (or anywhere inside the `agentTool: {...}` object — order doesn't matter).

- [ ] **Step 6: Run the full integration test**

Run: `npx vitest run src/mcp/integration.test.ts`
Expected: PASS — the existing `create_agent -> create_tool -> dry_run_tool -> attach_tool -> ...` flow still calls `attach_tool` with just `{agentId, toolId}`, which now upserts with deny-all capabilities and succeeds exactly as before (the test never exercises secrets/datastore/fetch through the attached tool).

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/tools.ts src/mcp/tools/tools.test.ts src/mcp/integration.test.ts
git commit -m "feat(mcp): accept and persist per-tool capabilities on attach_tool"
```

---

## Task 7: CLI `tool attach` capability flags

**Files:**
- Modify: `src/cli.ts`

No test file exists for `cli.ts` today (verified: no `cli*.test.ts` anywhere in `src/`), so this task is verified by a manual smoke check against the local dev DB rather than an automated test — don't invent a new CLI test harness for one function; that's out of scope for this fix.

**Interfaces:**
- Consumes: `ToolCapabilitiesPatchSchema` (Task 1).

- [ ] **Step 1: Add the import**

In `src/cli.ts`, add alongside the other local imports (near the top, e.g. after `import { validateCronExpression } from "./core/cron.js";`):
```ts
import { ToolCapabilitiesPatchSchema } from "./sandbox/tool-capabilities.js";
```

- [ ] **Step 2: Update `toolAttach`**

Change:
```ts
async function toolAttach(args: string[], detach: boolean): Promise<void> {
  const [toolName, agentName] = args;
  if (!toolName || !agentName) {
    fail(`tool ${detach ? "detach" : "attach"} requires <tool-name> <agent-name>.`);
  }

  const tool = await prisma.tool.findUnique({ where: { name: toolName! } });
  if (!tool) fail(`unknown tool "${toolName}".`);
  const agent = await prisma.agent.findUnique({ where: { name: agentName! } });
  if (!agent) fail(`unknown agent "${agentName}".`);

  if (detach) {
    await prisma.agentTool.deleteMany({ where: { agentId: agent!.id, toolId: tool!.id } });
    console.log(`detached "${toolName}" from "${agentName}".`);
  } else {
    await prisma.agentTool.upsert({
      where: { agentId_toolId: { agentId: agent!.id, toolId: tool!.id } },
      create: { agentId: agent!.id, toolId: tool!.id },
      update: {},
    });
    console.log(`attached "${toolName}" to "${agentName}".`);
  }
}
```
to:
```ts
async function toolAttach(args: string[], detach: boolean): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "allow-secret": { type: "string", multiple: true },
      "allow-datastore-prefix": { type: "string", multiple: true },
      "allow-host": { type: "string", multiple: true },
    },
  });
  const [toolName, agentName] = positionals;
  if (!toolName || !agentName) {
    fail(`tool ${detach ? "detach" : "attach"} requires <tool-name> <agent-name>.`);
  }

  const tool = await prisma.tool.findUnique({ where: { name: toolName! } });
  if (!tool) fail(`unknown tool "${toolName}".`);
  const agent = await prisma.agent.findUnique({ where: { name: agentName! } });
  if (!agent) fail(`unknown agent "${agentName}".`);

  if (detach) {
    await prisma.agentTool.deleteMany({ where: { agentId: agent!.id, toolId: tool!.id } });
    console.log(`detached "${toolName}" from "${agentName}".`);
    return;
  }

  const patch = ToolCapabilitiesPatchSchema.safeParse({
    allowedSecrets: values["allow-secret"],
    allowedDatastorePrefixes: values["allow-datastore-prefix"],
    allowedHosts: values["allow-host"],
  });
  if (!patch.success) {
    fail(`invalid tool capabilities: ${patch.error.issues.map((i) => i.message).join("; ")}`);
  }

  await prisma.agentTool.upsert({
    where: { agentId_toolId: { agentId: agent!.id, toolId: tool!.id } },
    create: {
      agentId: agent!.id,
      toolId: tool!.id,
      allowedSecrets: patch.data!.allowedSecrets ?? [],
      allowedDatastorePrefixes: patch.data!.allowedDatastorePrefixes ?? [],
      allowedHosts: patch.data!.allowedHosts ?? [],
    },
    update: {
      ...(patch.data!.allowedSecrets !== undefined ? { allowedSecrets: patch.data!.allowedSecrets } : {}),
      ...(patch.data!.allowedDatastorePrefixes !== undefined ? { allowedDatastorePrefixes: patch.data!.allowedDatastorePrefixes } : {}),
      ...(patch.data!.allowedHosts !== undefined ? { allowedHosts: patch.data!.allowedHosts } : {}),
    },
  });
  console.log(`attached "${toolName}" to "${agentName}".`);
}
```

- [ ] **Step 3: Build and smoke-test manually against the local dev DB**

Run:
```bash
npm run build
npm run db:up
node dist/cli.js tool create --name smoke_tool --description "smoke test" \
  --params <(echo 'z.object({})') --code <(echo 'return 1;')
node dist/cli.js agent create --name smoke_agent --model gpt-4o-mini --prompt "test" --budget 1
node dist/cli.js tool attach smoke_tool smoke_agent --allow-secret FOO --allow-host api.example.com
```
Expected: prints `attached "smoke_tool" to "smoke_agent".` with no thrown error. Then verify the row:
```bash
docker exec local-postgres-1 psql -U reevo -d reevo -c \
  'SELECT "allowedSecrets", "allowedHosts" FROM "AgentTool" LIMIT 1;'
```
Expected: `["FOO"]` and `["api.example.com"]`. Clean up the smoke-test rows afterward:
```bash
docker exec local-postgres-1 psql -U reevo -d reevo -c \
  'DELETE FROM "AgentTool"; DELETE FROM "Tool" WHERE name = '"'"'smoke_tool'"'"'; DELETE FROM "Agent" WHERE name = '"'"'smoke_agent'"'"';'
```

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): add capability flags to tool attach"
```

---

## Task 8: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Re-run the drift check** (schema hasn't changed since Task 1, but this is the final gate before calling the migration done)

Run the exact sequence from Task 1 Step 8. Expected: `-- This is an empty migration.`

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: every test file passes (the pre-existing DB-skip messages for `DATABASE_URL`-gated suites are expected and unrelated).

- [ ] **Step 3: Run the build**

Run: `npm run build`
Expected: clean TypeScript build, no errors.

- [ ] **Step 4: Update the review-findings memory**

This isn't a code change, but close the loop: update the `reevo-run-code-review-findings` memory to move "Excessive Agency (OWASP LLM08)" from "Still open" to "Already fixed," noting the commit range and the backfill decision (pre-existing attachments keep unrestricted access via `["*"]`/`[""]`/full-secret-set backfill; new attachments default to deny-all).

- [ ] **Step 5: Final commit (if anything is uncommitted)**

```bash
git status
```
If clean, nothing to do — every task above already committed its own changes.
