# Per-Attachment Secret Binding Name — Design

**Date:** 2026-09-10
**Status:** Proposed (design; not yet planned or implemented)
**Author:** wardby maintainer
**Related:** `docs/private/2026-09-07-migration-bundle-spec.md` (§ secrets/alias); Tier-1 importer finding **F2** (shared-alias collapse)

> **Clean-room note.** This is a wardby platform change grounded entirely in
> wardby's own data model. It describes the _concept_ of a per-attachment alias
> (which wardby already documents in the migration-bundle spec) and does not read
> from or copy any agent-cron source.

---

## Goal

Let a single agent reference a secret at sandbox point-of-use by a **stable
logical name** (`secrets.get("bitbucket")`) while different agents resolve that
same logical name to **different underlying secrets**. This is the indirection
layer wardby's schema currently lacks, and its absence is the root cause of
importer finding F2.

## Background: what breaks today

wardby folds two distinct axes into one:

- **Secret identity** — `Secret.name`, unique per owner (`@@unique([ownerId, name])`).
- **Point-of-use name** — the string a tool passes to `secrets.get(name)`.

`AgentSecret` (`@@id([agentId, secretId])`) carries no per-attachment name, and
`buildSecretsAccessor(agentId).get(name)` resolves straight to `Secret.name`:

```sql
FROM "Secret" s JOIN "AgentSecret" a ON a."secretId" = s."id"
WHERE a."agentId" = ${agentId} AND s."name" = ${name} LIMIT 1
```

That is correct only when one logical name maps to one physical secret per
owner — true for greenfield wardby agents. It fails on import, where many
physically-distinct secrets (`bitbucket_aies`, `bitbucket_ondemand`,
`bitbucket_lexitas_infra`, …) all want to answer to the logical name
`bitbucket`. wardby has nowhere to store that fan-out, so the importer's current
workaround creates one `Secret` row **per distinct effective name** and attaches
every aliased edge to the alias-named row. Result on the real bundle:

- The single `bitbucket` row absorbs **49 agents** (last-decrypted value wins).
- The single `jira` row absorbs **14 agents**.
- The 16 correct `bitbucket_*` / distinct base-name rows sit **orphaned (0
  attachments)** — 23 of 39 rows orphaned overall.

At runtime, agents that should hold distinct credentials all read the one
shared value → they authenticate against the wrong workspace / get 401s,
silently (the import reports success).

## Non-goals

- Not part of Tier-1 importer scope. This is a standalone wardby model change; it
  is a prerequisite for the importer to round-trip aliased secrets faithfully,
  but it stands on its own for any wardby user who wants two secrets under one
  point-of-use name.
- No change to the transfer-envelope crypto, the reference-mode secret flow, or
  the `SecretCipher` provider interface.
- No change to secret **identity** uniqueness (`Secret` stays unique per
  `(ownerId, name)`).
- Does not add "one physical secret under multiple aliases for the _same_
  agent" — the attachment cardinality stays one row per `(agent, secret)`.

---

## Design

Introduce a **bound name** on the attachment: the point-of-use string an agent
uses to reach a secret. It defaults to the secret's canonical name and is only
different when an alias is in play. Resolution keys on the bound name instead of
the secret's name.

### Why `boundName` (non-null) over a nullable `alias`

A nullable `alias` with `COALESCE(a."alias", s."name")` resolution was
considered and rejected:

- The correctness invariant is "one point-of-use name per agent." A non-null
  `boundName` lets Postgres enforce that directly with `@@unique([agentId,
boundName])`. With a nullable alias, a row where `alias IS NULL` (effective =
  `s.name`) can silently collide with another row where `alias = 'foo'` and
  `s.name` happens to equal `foo` for the first — a collision the unique index
  cannot see.
- Resolution becomes a plain equality (`a."boundName" = ${name}`), fully
  index-backed, no `COALESCE`.

Denormalizing the point-of-use name onto the attachment is _semantically_
correct here: the name tool code uses must be independent of the underlying
secret's canonical name, so renaming the secret must not move the binding.

### 1. Schema (`prisma/schema.prisma`)

```prisma
/// Phase 4: attaches a secret to an agent, addressed at sandbox point-of-use
/// by `boundName` (secrets.get(boundName)). `boundName` defaults to the
/// secret's canonical name; it differs only when the agent binds the secret
/// under an alias, letting two agents resolve the same logical name to
/// different underlying secrets.
model AgentSecret {
  agentId   String
  secretId  String
  boundName String
  agent     Agent  @relation(fields: [agentId], references: [id])
  secret    Secret @relation(fields: [secretId], references: [id])

  @@id([agentId, secretId])
  @@unique([agentId, boundName])
}
```

`Secret` is unchanged.

### 2. Migration (manual SQL, following wardby's timestamped convention)

New dir `prisma/migrations/<next-timestamp>_agent_secret_bound_name/migration.sql`:

```sql
-- 1. Add nullable so existing rows survive the ADD.
ALTER TABLE "AgentSecret" ADD COLUMN "boundName" TEXT;

-- 2. Backfill: existing attachments resolve by the secret's canonical name,
--    so their point-of-use name IS that name.
UPDATE "AgentSecret" a
SET "boundName" = s."name"
FROM "Secret" s
WHERE a."secretId" = s."id";

-- 3. Lock it down.
ALTER TABLE "AgentSecret" ALTER COLUMN "boundName" SET NOT NULL;

-- 4. One point-of-use name per agent.
CREATE UNIQUE INDEX "AgentSecret_agentId_boundName_key"
  ON "AgentSecret" ("agentId", "boundName");
```

This is purely additive + backfill; every existing attachment keeps identical
runtime behavior (`boundName` == the name it already resolved by).

### 3. Core API (`src/core/secrets.ts`)

**`attachSecret`** — gains a `boundName` parameter (defaults to the secret
name, preserving today's one-arg callers' behavior):

```ts
export async function attachSecret(
  agentId: string,
  name: string, // the secret's CANONICAL name — how we find the row
  ownerId: string,
  db: PrismaClient,
  boundName: string = name, // point-of-use name; defaults to the canonical name
): Promise<void> {
  const secret = await findOwnedSecretByName(db, ownerId, name);
  if (!secret) throw new Error(`No secret named "${name}" owned by this caller.`);
  await db.agentSecret.create({ data: { agentId, secretId: secret.id, boundName } });
}
```

**`detachSecret`** — targets the **point-of-use name**, not the secret name,
since that is what an agent config knows and what `get()` resolves by:

```ts
export async function detachSecret(agentId: string, boundName: string, db: PrismaClient): Promise<void> {
  await db.agentSecret.deleteMany({ where: { agentId, boundName } });
}
```

(Drops the `ownerId`/`findOwnedSecretByName` lookup — the `(agentId,
boundName)` pair already uniquely identifies the edge, and agent ownership is
enforced by the caller, e.g. `requireOwnedAgent` in the MCP tool.)

**`buildSecretsAccessor.get(name)`** — both code paths resolve by `boundName`:

```ts
// production ($queryRaw) path:
//   ... WHERE a."agentId" = ${agentId} AND a."boundName" = ${name} LIMIT 1

// lightweight Prisma-double path:
const attachment = await db.agentSecret.findFirst({
  where: { agentId, boundName: name },
  include: { secret: true },
});
```

`buildSecretsAccessor`'s signature is unchanged, so its one caller
(`src/core/runner.ts:173`) needs no change.

**`scopeSecretsAccessor` stays as-is.** It filters `get()` by the tool's
allowed point-of-use names (`AgentTool.allowedSecrets`). Those entries are
already point-of-use names, and `get()` now resolves by exactly that, so the
capability allow-list keeps working with no change — the change is _consistent_
across attach, get, and scope.

### 4. Importer (`src/import/create.ts`)

**Step 4 — create one row per base secret.** Delete the effective-name fan-out
(`secretAliasMap`, the per-effective-name create loop, and the base/alias
duplicate warning). Create exactly one `Secret` under the secret's canonical
name:

```ts
for (const s of bundle.readSecrets()) {
  if (!s.ciphertext) { warnings.push(...); continue; }
  let plaintext: string;
  try {
    plaintext = decryptTransferEnvelope(s.ciphertext, s.name, transferPrivateKey); // AAD = base name, unchanged
  } catch (err) { warnings.push(...); continue; }
  await createSecret(s.name, plaintext, owner, cipher, db);
  secretsCreated++; // now one increment per real secret row — also fixes F1's over-count
}
```

**Step 5 — attach with the alias as the bound name.** Resolve the secret by its
canonical name, bind it under the point-of-use name:

```ts
for (const as of bundle.readAgentSecrets()) {
  const agentId = agentIdMap.get(as.agentName);
  if (!agentId) continue;
  const boundName = as.alias ?? as.secretName;
  try {
    await attachSecret(agentId, as.secretName, owner, db, boundName);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Two secrets bound to the same point-of-use name for one agent: a
      // genuine bundle inconsistency. Surface it instead of silently skipping.
      warnings.push(`agent-secret ${as.agentName}: "${boundName}" already bound to a different secret — skipped`);
      continue;
    }
    warnings.push(`agent-secret ${as.agentName}/${as.secretName}: failed to attach (${...})`);
  }
}
```

Net effect on the real bundle: 39 distinct base-name `Secret` rows, each with
its own decrypted value; 97 `AgentSecret` rows whose `boundName` is the
point-of-use name; every agent resolves `bitbucket` to _its own_ credential; no
orphans. Fixes **F2** (correctness) and **F1** (`secretsCreated` now counts rows).

### 5. MCP surface (`src/mcp/tools/secrets.ts`)

- `attach_secret` — add an optional `alias` (or `boundName`) string to
  `inputSchema.properties`; pass it through as the `boundName` arg. When absent,
  behavior is identical to today (bind under the secret's own name).
- `detach_secret` — its `name` argument now means the **point-of-use name**.
  For the overwhelming common case (never aliased) `boundName == secret name`,
  so existing callers are unaffected; document the shift for aliased edges.

---

## Data flow (after change)

```
import: bundle secret "bitbucket_aies" (ciphertext, AAD="bitbucket_aies")
  → createSecret("bitbucket_aies", plaintext, owner)         → Secret row (canonical)
  → agent-secret edge {agent: A, secret: "bitbucket_aies", alias: "bitbucket"}
  → attachSecret(A, "bitbucket_aies", owner, db, "bitbucket") → AgentSecret{A, id, boundName:"bitbucket"}

runtime: tool on agent A calls secrets.get("bitbucket")
  → scopeSecretsAccessor: "bitbucket" ∈ allowedSecrets?  yes
  → accessor.get("bitbucket")
  → WHERE a.agentId = A AND a.boundName = "bitbucket"      → the bitbucket_aies row → decrypt
```

## Error handling

- **Duplicate point-of-use name for one agent** — DB rejects with P2002 on
  `AgentSecret_agentId_boundName_key`. `attachSecret` surfaces it; the importer
  converts it to a warning (see Step 5). MCP `attach_secret` maps it to a clear
  409/400-style `McpError` ("agent already binds a secret under name X").
- **Attaching a nonexistent secret** — unchanged: `attachSecret` throws "No
  secret named …".
- **Missing/unattached name at get()** — unchanged: returns `undefined`
  (indistinguishable from never-created), preserving the existing convention.

## Testing

Unit — `src/core/secrets.test.ts`:

1. Two agents each attach a _different_ secret under the same `boundName`;
   `get()` returns each agent's own distinct value. (Direct F2 regression.)
2. One agent attaches two secrets under two distinct bound names; `get()`
   resolves each correctly.
3. One agent attaching two different secrets under the _same_ bound name → the
   second `attachSecret` rejects (P2002).
4. `boundName` defaults to the secret name when the arg is omitted (back-compat).
5. Both accessor paths covered: the `$queryRaw` production path and the
   Prisma-double fallback (`agentSecret.findFirst`).
6. `detachSecret(agent, boundName)` removes only the matching edge.

Integration — `src/import/create.test.ts`: 7. Bundle with two agents, two distinct base secrets, both aliased to
`bitbucket`: assert two `Secret` rows under base names, two `AgentSecret`
rows with `boundName = "bitbucket"`, `secretsCreated == 2`, and an accessor
per agent returns the right token. (The test the current importer lacks.)

MCP — `src/mcp/tools/secrets.test.ts` (if present): `attach_secret` with and
without `alias`; `detach_secret` by point-of-use name.

## Rollout / backward compatibility

- Migration is additive + backfill; existing attachments keep identical
  behavior (`boundName` backfilled to the name they already resolved by).
- `attachSecret`'s new parameter is defaulted, so non-importer callers compile
  and behave unchanged.
- No data recovery needed for a _re-import_: a fresh import under this change
  produces the correct graph. (An already-imported DB carrying F2 damage would
  need a re-import or a one-off remap, out of scope here.)

## Open questions

1. **Column name** — `boundName` vs `alias`. This doc uses `boundName` because
   the column is always populated (an alias connotes optionality). Cheap to
   rename before implementation.
2. **MCP `detach_secret` semantics** — confirm callers expect point-of-use
   naming (they should, to match `get()`), or add a separate detach-by-secret
   variant if any workflow relies on removing all bindings of a physical secret.
3. **Scope/sequencing** — land as its own small SDD plan (schema + migration +
   core + importer Steps 4/5 + tests), then re-run the Tier-1 importer live-fire
   to confirm F1/F2 are gone. Roughly one migration + two core functions + one
   importer section + tests.
