# Named / Shared Datastores — Design

**Date:** 2026-09-12
**Status:** Proposed (design; not yet planned or implemented)
**Author:** reevo-run maintainer
**Related:** `docs/private/2026-09-05-roadmap-mcp-native.md` (un-phased "Named / shared
datastores" item); `docs/private/2026-09-07-migration-bundle-spec.md`
(§ `datastores-shared.json`); `docs/private/2026-09-08-tier1-importer-plan.md`
(shared-datastores currently a skipped capability);
`docs/superpowers/specs/2026-09-10-per-attachment-secret-binding-name-design.md`
(the `boundName` precedent this design reuses)

> **Clean-room note.** This is a reevo-run platform change grounded entirely in
> reevo's own data model. It describes the _concept_ of a named datastore shared
> across agents (which the migration-bundle spec already documents as a gated
> capability reevo lacks) and does not read from or copy any agent-cron source.

---

## Goal

Let multiple agents read and write a common, named key/value store — closing
the gap the roadmap and migration-bundle docs already flag: _"agent-cron has
named datastores shared across agents; reevo's is per-agent."_ Land the core
subsystem (schema, ownership, attach/detach, sandbox API, MCP tools) and wire
the Tier-1 importer to consume `config/datastores-shared.json` instead of
unconditionally skipping it.

## Background: what's missing today

reevo's `Datastore` seam (`src/providers/datastore/`) is strictly per-agent:
`DatastoreEntry` is keyed `(agentId, key)`, and every sandboxed tool call is
bound to its own run's `agentId` before it ever reaches `datastore.get/set`
(`src/sandbox/host-functions.ts`). There is no resource one agent can name and
a second agent can attach to. The Tier-1 importer already anticipates this:
`docs/private/2026-09-07-migration-bundle-spec.md` documents the source
system's `Datastore` + `AgentDatastore` M2M shape and ships shared-store
definitions under `config/datastores-shared.json`
(`{ name, ownerEmail, attachedAgentNames[], entries[] }`), but the importer
treats `shared-datastores` as a **gated capability that is always skipped, not
substituted** — real bundles lose this data on import today.

## Non-goals

- Cross-_principal_ sharing (a datastore owned by A attached to an agent owned
  by B). Attaching still requires owning both the datastore and the agent —
  the roadmap doc explicitly defers "access grants / sharing" until a concrete
  need appears; this design composes with that later work rather than
  building it now.
- Per-attachment PII flag or per-agent aliasing for _shared_ entries seeded by
  the importer — the source bundle shape carries neither field, so importing
  `datastores-shared.json` faithfully means plain, store-name-bound entries.
  Anyone wanting PII-flagged or aliased shared data sets that up post-import
  via the new MCP tools.
- Locking, versioning, or any concurrency control beyond the existing
  upsert-is-last-write-wins semantics `DatastoreEntry.set` already has.
- Changing the existing private `datastore.*` sandbox API or its capability
  scoping in any way. It is untouched by this design.

---

## Design

### 1. Data model (`prisma/schema.prisma`)

A new named, owned resource — `Datastore` — analogous to `Secret`/`Tool`,
attached to agents via an M2M join that carries a per-attachment `boundName`,
reusing the pattern the secret-binding design just established:

```prisma
/// A named key/value store shared across agents via AgentDatastore. Null
/// ownerId = public/unowned, matching Tool's convention.
model Datastore {
  id        String           @id @default(cuid())
  name      String
  ownerId   String?
  owner     Principal?       @relation(fields: [ownerId], references: [id])
  agents    AgentDatastore[]
  createdAt DateTime         @default(now())
  updatedAt DateTime         @updatedAt

  @@unique([ownerId, name])
}

/// Attaches a Datastore to an agent, addressed at sandbox point-of-use by
/// `boundName` (sharedDatastore.get(boundName, key)) — same boundName
/// convention as AgentSecret. Defaults to the datastore's own name.
model AgentDatastore {
  agentId     String
  datastoreId String
  boundName   String
  agent       Agent     @relation(fields: [agentId], references: [id])
  datastore   Datastore @relation(fields: [datastoreId], references: [id])

  @@id([agentId, datastoreId])
  @@unique([agentId, boundName])
}
```

**Unifying the keyspace.** `DatastoreEntry` gains a nullable `datastoreId`
alongside the existing `agentId`. Exactly one of the two is set per row
(private vs. shared) — purely additive, so every existing row (`agentId` set,
`datastoreId` null) is untouched:

```prisma
model DatastoreEntry {
  agentId     String?
  datastoreId String?
  key         String
  value       Json
  pii         Boolean   @default(false)
  keyId       String?
  updatedAt   DateTime  @updatedAt
  datastore   Datastore? @relation(fields: [datastoreId], references: [id])

  @@unique([agentId, key])
  @@unique([datastoreId, key])
}
```

Prisma can't declaratively express "exactly one of two columns is non-null,"
so the migration SQL adds a `CHECK` constraint by hand (no drift risk — it's
pure SQL with no `schema.prisma` representation to diverge from, same
convention as `AgentMemory.contentTsv`).

### 2. Migration (manual SQL)

New dir `prisma/migrations/<next-timestamp>_named_shared_datastores/migration.sql`:

```sql
-- 1. New named/owned resource.
CREATE TABLE "Datastore" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "ownerId" TEXT REFERENCES "Principal"("id"),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "Datastore_ownerId_name_key" ON "Datastore" ("ownerId", "name");

-- 2. M2M attachment.
CREATE TABLE "AgentDatastore" (
  "agentId" TEXT NOT NULL REFERENCES "Agent"("id"),
  "datastoreId" TEXT NOT NULL REFERENCES "Datastore"("id"),
  "boundName" TEXT NOT NULL,
  PRIMARY KEY ("agentId", "datastoreId")
);
CREATE UNIQUE INDEX "AgentDatastore_agentId_boundName_key" ON "AgentDatastore" ("agentId", "boundName");

-- 3. Unify DatastoreEntry's keyspace: add nullable datastoreId, make agentId
--    nullable (existing rows keep agentId set, datastoreId null).
ALTER TABLE "DatastoreEntry" ALTER COLUMN "agentId" DROP NOT NULL;
ALTER TABLE "DatastoreEntry" ADD COLUMN "datastoreId" TEXT REFERENCES "Datastore"("id");
ALTER TABLE "DatastoreEntry" ADD CONSTRAINT "DatastoreEntry_scope_xor"
  CHECK (("agentId" IS NOT NULL) <> ("datastoreId" IS NOT NULL));

-- 4. Replace the old (agentId, key) primary key with two scoped unique
--    indexes, since datastoreId-scoped rows have a null agentId.
ALTER TABLE "DatastoreEntry" DROP CONSTRAINT "DatastoreEntry_pkey";
CREATE UNIQUE INDEX "DatastoreEntry_agentId_key_key" ON "DatastoreEntry" ("agentId", "key");
CREATE UNIQUE INDEX "DatastoreEntry_datastoreId_key_key" ON "DatastoreEntry" ("datastoreId", "key");

-- 5. Per-attachment capability scoping for shared stores, mirroring
--    AgentTool.allowedDatastorePrefixes.
ALTER TABLE "AgentTool" ADD COLUMN "allowedSharedDatastorePrefixes" JSONB NOT NULL DEFAULT '{}';
```

Purely additive + one column-nullability relaxation; no data loss, no
backfill needed since no shared datastores exist yet.

### 3. Core API (`src/core/datastores.ts`, new file)

```ts
export async function createDatastore(name: string, ownerId: string, db: PrismaClient): Promise<Datastore> {
  return db.datastore.create({ data: { name, ownerId } });
}

export async function attachDatastore(
  agentId: string,
  datastoreId: string,
  boundName: string, // defaults to the datastore's own name at the MCP layer
  db: PrismaClient,
): Promise<void> {
  await db.agentDatastore.create({ data: { agentId, datastoreId, boundName } });
}

export async function detachDatastore(agentId: string, boundName: string, db: PrismaClient): Promise<void> {
  await db.agentDatastore.deleteMany({ where: { agentId, boundName } });
}
```

`attachDatastore`/`detachDatastore` mirror `attachSecret`/`detachSecret`'s
shape exactly: attach resolves by identity (`datastoreId`), detach targets the
point-of-use `boundName`. Ownership (`requireOwnedDatastore`, analogous to
`requireOwnedAgent`) is enforced by the caller (MCP tool / importer), not
inside these functions — same division of responsibility as the secret path.

### 4. Datastore provider changes (`src/providers/datastore/`)

`Datastore` interface (`types.ts`) gains a shared-scope sibling to each method,
taking a `datastoreId` instead of `agentId`:

```ts
export interface Datastore {
  get(agentId: string, key: string): Promise<DatastoreValue | undefined>;
  set(agentId: string, key: string, value: DatastoreValue, opts?: DatastoreSetOptions): Promise<void>;
  delete(agentId: string, key: string): Promise<void>;
  list(agentId: string, prefix?: string): Promise<string[]>;

  getShared(datastoreId: string, key: string): Promise<DatastoreValue | undefined>;
  setShared(datastoreId: string, key: string, value: DatastoreValue, opts?: DatastoreSetOptions): Promise<void>;
  deleteShared(datastoreId: string, key: string): Promise<void>;
  listShared(datastoreId: string, prefix?: string): Promise<string[]>;
}
```

`PostgresDatastore`'s shared methods are near-identical to the existing ones,
querying/upserting on `datastoreId` instead of `agentId` — same
`BRIDGE_INPUT_BYTES`/`PII_PLAINTEXT_BYTES` guards, same 1000-key list cap. No
inheritance trick attempted; four short mirrored methods are clearer than a
generic "scope column" abstraction for four call sites.

`scopeDatastore` (`scoped.ts`) gains a matching `scopeSharedDatastore` that
resolves `boundName` → `datastoreId` via `AgentDatastore` (scoped to the
running agent) before delegating, and checks
`allowedSharedDatastorePrefixes[boundName]` instead of a flat prefix list.
Missing/empty entry for a `boundName` = no access, same default-deny
convention as today.

### 5. Sandbox API (`src/sandbox/`)

**A new global, not an overload of `datastore.*`.** The existing
`datastore.get/set/delete/list` (`src/sandbox/prelude.ts`) keep their exact
signature and behavior — zero back-compat risk for every existing tool.
Shared access is a separate global keyed by bound name:

```js
// prelude.ts
globalThis.sharedDatastore = {
  get: async (boundName, key) => JSON.parse(await __bridge_sharedDatastoreGet(JSON.stringify([boundName, key]))),
  set: async (boundName, key, value, opts) => {
    await __bridge_sharedDatastoreSet(JSON.stringify([boundName, key, value, opts]));
  },
  delete: async (boundName, key) => {
    await __bridge_sharedDatastoreDelete(JSON.stringify([boundName, key]));
  },
  list: async (boundName, prefix) =>
    JSON.parse(await __bridge_sharedDatastoreList(JSON.stringify([boundName, prefix ?? null]))),
};
```

`host-functions.ts` registers four matching `__bridge_sharedDatastore*`
functions. Each resolves `boundName` → `datastoreId` for the running
`agentId` via `scopeSharedDatastore`, then delegates to the provider's
`*Shared` methods. Behavior on an unbound name: reads/lists behave like a
cache-miss (matches `scopeDatastore`'s existing read-side convention); writes
throw (matches its existing write-side convention).

### 6. Capability scoping (`AgentTool`, `tool-capabilities.ts`)

New field `allowedSharedDatastorePrefixes: Json` (default `{}`), shaped
`{ [boundName: string]: string[] }` — same `datastorePrefixSchema` validation
per entry, capped the same way `allowedDatastorePrefixes` is
(`MAX_ALLOWED_DATASTORE_PREFIXES` per bound name). Empty/missing = no access
to that store at all, consistent with the existing "explicit grant only" rule
this whole capability-scoping system enforces (OWASP LLM08).

### 7. MCP surface (`src/mcp/tools/datastore.ts`)

New tools, mirroring `create_secret`/`attach_secret`/`detach_secret`:

- **`create_datastore(name)`** — owned by caller.
- **`attach_datastore(agentId, datastoreId, boundName?)`** — requires owning
  both the datastore and the agent (`requireOwnedDatastore` +
  `requireOwnedAgent`); `boundName` defaults to the datastore's `name`. P2002
  on the unique constraint → clear "agent already binds a datastore under name
  X" error.
- **`detach_datastore(agentId, boundName)`** — targets the point-of-use name.

Existing tools gain an optional `boundName`:

- **`datastore_get`/`datastore_list`** — `boundName` present → read the shared
  store (still behind `requireReadableAgent` on the agent); absent → today's
  private behavior, unchanged.
- **`datastore_set`/`datastore_delete`** — same split, still behind
  `requireOwnedAgent`.

### 8. Importer (`src/import/`)

**Parsing** (`neutral-schema.ts`): a reader for `config/datastores-shared.json`
— `[{ name, ownerEmail, attachedAgentNames: string[], entries: [{ key, value }] }]`,
matching the migration-bundle spec's shape exactly.

**Creation** (`create.ts`), a new step alongside the existing tool/secret/
single-datastore steps:

```ts
for (const ds of bundle.readSharedDatastores()) {
  const ownerId = await resolveOwnerByEmail(ds.ownerEmail, db); // existing helper
  const datastore = await createDatastore(ds.name, ownerId, db);
  for (const entry of ds.entries) {
    await db.datastoreEntry.create({
      data: { datastoreId: datastore.id, key: entry.key, value: entry.value, pii: false },
    });
  }
  for (const agentName of ds.attachedAgentNames) {
    const agentId = agentNameMap.get(agentName);
    if (!agentId) continue;
    try {
      await attachDatastore(agentId, datastore.id, ds.name, db); // boundName = store's own name
    } catch (err) {
      if (isP2002(err)) {
        warnings.push(`shared-datastore ${ds.name}: agent ${agentName} already binds "${ds.name}" — skipped`);
        continue;
      }
      throw err;
    }
  }
  datastoresSharedCreated++;
}
```

**Manifest/report bookkeeping:** drop `shared-datastores` from
`capabilitiesSupported`'s skip list — only `subagents`/`memory` remain
skipped. Add a `datastoresShared` count to the import report, alongside the
existing `datastoresSingle` count.

---

## Data flow (after change)

```
import: config/datastores-shared.json
  { name: "shared-kb", ownerEmail: "...", attachedAgentNames: ["a","b"], entries: [...] }
  → createDatastore("shared-kb", ownerId)              → Datastore row
  → entries seeded with datastoreId = that row's id     → DatastoreEntry rows
  → attachDatastore(agentA, ds.id, "shared-kb")         → AgentDatastore{A, ds, boundName:"shared-kb"}
  → attachDatastore(agentB, ds.id, "shared-kb")         → AgentDatastore{B, ds, boundName:"shared-kb"}

runtime: a tool on agent A (granted allowedSharedDatastorePrefixes: {"shared-kb": [""]})
  calls sharedDatastore.get("shared-kb", "some-key")
  → scopeSharedDatastore: resolve boundName "shared-kb" for agent A → ds.id
  → prefix check against allowedSharedDatastorePrefixes["shared-kb"]
  → provider.getShared(ds.id, "some-key")               → same row agent B's tools can read
```

## Error handling

- **Duplicate bound name for one agent** (two shared attachments, or an
  importer boundName collision across differently-owned stores) — P2002 on
  `AgentDatastore_agentId_boundName_key`; `attachDatastore` surfaces it, MCP
  maps it to a 409/400-style error, importer downgrades to a warning.
- **Attaching a datastore you don't own, or to an agent you don't own** —
  rejected by `requireOwnedDatastore`/`requireOwnedAgent` before the write.
- **Unbound `boundName` at `sharedDatastore.get`/`list`** — behaves like a
  cache-miss (empty/undefined), matching `datastore.get`'s existing
  never-created convention.
- **Unbound `boundName` at `sharedDatastore.set`/`delete`, or prefix-denied
  write** — throws (`datastore_prefix_not_allowed` or a new
  `datastore_not_bound`), matching the existing write-side "don't silently
  drop a write" convention in `scoped.ts`.
- **`DatastoreEntry` CHECK constraint** — defense-in-depth only; application
  code never constructs a row violating it.

## Testing

Unit — `src/providers/datastore/postgres.test.ts`:

1. Shared get/set/delete/list scoped by `datastoreId`; two different
   `datastoreId`s never see each other's keys.
2. Existing private-scope tests untouched and still passing (regression guard
   for the nullable-`agentId` change).

Unit — `src/providers/datastore/scoped.test.ts`: 3. `scopeSharedDatastore` resolves a bound name to the right `datastoreId` for
the calling agent; a name unbound for that agent denies read (undefined)
and write (throw). 4. Prefix allow/deny per bound name; empty/missing map = full deny.

Core — `src/core/datastores.test.ts` (new): 5. `attachDatastore` twice with different datastores under the same
`boundName` for one agent → second rejects (P2002). 6. `detachDatastore` removes only the matching edge. 7. Two agents attached to the same `Datastore` both see writes the other made.

Sandbox — `src/sandbox/host-functions.test.ts`: 8. `sharedDatastore.*` bridge round-trips through a real bound name; an
unbound name behaves per the rules above.

MCP — `src/mcp/tools/datastore.test.ts`: 9. `create_datastore`/`attach_datastore`/`detach_datastore` end-to-end,
including the cross-owner-attach rejection. 10. `datastore_get`/`datastore_set` with and without `boundName`.

Integration — `src/import/create.test.ts`: 11. A bundle with one shared store attached to two agents → one `Datastore`
row, two `AgentDatastore` rows, entries visible to both agents via
`sharedDatastore.get`; `datastoresSharedCreated` count correct. 12. A boundName collision across two differently-owned shared stores on one
agent → warning, not a crash; the first attachment wins.

## Rollout / backward compatibility

- Migration is additive plus one nullability relaxation (`DatastoreEntry.agentId`
  becomes nullable) — no backfill needed, since no shared datastores exist in
  any deployed database yet. Runs the standard drift check
  (`CLAUDE.md` § Database/Prisma) before commit.
- No behavior change for any existing agent or tool that doesn't opt into a
  shared attachment: `datastore.*` sandbox API, `allowedDatastorePrefixes`,
  and every existing MCP tool call (`boundName` omitted) are byte-for-byte
  unchanged.
- Re-running import on a bundle that previously skipped `shared-datastores`
  now creates the shared stores; re-running it again would duplicate them
  (same pre-existing idempotency gap the rest of the importer has — out of
  scope here).

## Open questions

1. **`requireOwnedDatastore` naming/location** — likely
   `src/mcp/auth/ownership.ts`, alongside `requireOwnedAgent`/
   `requireReadableAgent`. Trivial to place during implementation.
2. **Should `allowedSharedDatastorePrefixes` default a newly-attached store to
   a wildcard prefix (`[""]`) or stay empty (`{}`, no access) until a tool is
   explicitly granted it?** This design assumes empty/explicit-grant-only, to
   stay consistent with the existing `allowedDatastorePrefixes` default-deny
   rule — flagging in case that's not the intended UX for a first shared
   attachment.
3. **Scope/sequencing** — one migration + core module + provider changes +
   sandbox global + MCP tools + importer step + tests. Large enough to land
   as its own plan via `writing-plans`, likely split into 2-3 implementation
   tasks (schema+provider+sandbox; MCP surface; importer wiring).
