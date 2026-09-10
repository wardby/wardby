# Per-Attachment Secret Binding Name — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `AgentSecret` a per-attachment `boundName` so different agents can resolve the same point-of-use name (`secrets.get("bitbucket")`) to different underlying secrets — fixing importer findings F2 (shared-alias collapse) and F1 (secret over-count).

**Architecture:** Add a non-null `boundName` column to `AgentSecret` (the point-of-use name; defaults to the secret's canonical name), unique per agent. Secret resolution (`buildSecretsAccessor.get`, both the `$queryRaw` production path and the Prisma-double fallback) keys on `boundName` instead of `Secret.name`. `attachSecret` gains an optional `boundName` argument; `detachSecret` targets `(agentId, boundName)`. The importer creates one `Secret` row per base secret and attaches each edge under its alias.

**Tech Stack:** TypeScript ESM (Node ≥22.12), Prisma 6, PostgreSQL 16, Vitest 3, node:crypto.

**Spec:** `docs/superpowers/specs/2026-09-10-per-attachment-secret-binding-name-design.md`

## Global Constraints

- **ESM with explicit `.js` import specifiers** in every relative import. Node ≥22.12.
- **No new runtime dependencies.** node:crypto and existing deps only.
- **Prisma migrations only** — never `prisma db push`. reevo uses timestamped migration dirs (`prisma migrate dev`). This migration is additive + backfill; it must never fail on existing rows.
- **Never modify an already-applied migration file.** Add a new one.
- **Secret plaintext is never logged or returned.** Preserve the existing "unattached name → `undefined`" convention (never a throw for a missing name).
- **`Secret` identity uniqueness is unchanged** (`@@unique([ownerId, name])`). Only the *attachment* gains a name.
- **Logging:** pino (`@/lib/logger` equivalent in this repo), never `console.*`. (No new logging is required by this plan.)
- **Verify before commit:** `npm run build` (tsc) and `npm test` (vitest) must pass. DB-gated tests (`describe.skipIf(!process.env.DATABASE_URL)`) require `npm run db:up` + `DATABASE_URL` from `.env.local`.

**Decisions locked (were open questions in the spec):**
1. Column name is **`boundName`** (non-null), not a nullable `alias`.
2. `detachSecret` identifies the edge by **point-of-use name** `(agentId, boundName)` and drops its now-unused `ownerId` parameter.

---

### Task 1: Schema + migration — add `boundName` to `AgentSecret`

**Files:**
- Modify: `prisma/schema.prisma` (the `AgentSecret` model, ~line 382)
- Create: `prisma/migrations/<generated-timestamp>_agent_secret_bound_name/migration.sql`
- Modify: `src/core/secrets.database.test.ts:17` (an `agentSecret.create` that omits `boundName` will fail the new NOT NULL)

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentSecret.boundName: string` (non-null), unique index `@@unique([agentId, boundName])`. Every consumer of the Prisma client sees the new field.

- [ ] **Step 1: Update the schema model**

In `prisma/schema.prisma`, replace the `AgentSecret` model with:

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

- [ ] **Step 2: Generate the migration without applying it**

Run: `npx prisma migrate dev --create-only --name agent_secret_bound_name`
Expected: a new `prisma/migrations/<timestamp>_agent_secret_bound_name/migration.sql` is written. Prisma will draft a non-null `ADD COLUMN` (which would fail on existing rows) — you will replace its body in the next step.

*Fallback if the shadow DB errors:* generate the diff with `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`, or hand-author the file below and `npx prisma migrate resolve --applied <migration-name>`.

- [ ] **Step 3: Replace the migration SQL with the additive backfill**

Overwrite `migration.sql` with exactly:

```sql
-- Add nullable so existing rows survive the ADD.
ALTER TABLE "AgentSecret" ADD COLUMN "boundName" TEXT;

-- Backfill: existing attachments resolve by the secret's canonical name,
-- so their point-of-use name IS that name.
UPDATE "AgentSecret" a
SET "boundName" = s."name"
FROM "Secret" s
WHERE a."secretId" = s."id";

-- Lock it down.
ALTER TABLE "AgentSecret" ALTER COLUMN "boundName" SET NOT NULL;

-- One point-of-use name per agent.
CREATE UNIQUE INDEX "AgentSecret_agentId_boundName_key"
  ON "AgentSecret" ("agentId", "boundName");
```

- [ ] **Step 4: Apply the migration and regenerate the client**

Run: `npx prisma migrate dev` (applies the pending migration) then `npx prisma generate`.
Expected: migration applies clean; `PrismaClient` types now include `AgentSecret.boundName`.

- [ ] **Step 5: Fix the DB test that constructs an `AgentSecret` without `boundName`**

In `src/core/secrets.database.test.ts`, line 17, change:

```ts
await db.agentSecret.create({ data: { agentId: id, secretId: id } });
```
to:
```ts
await db.agentSecret.create({ data: { agentId: id, secretId: id, boundName: "legacy" } });
```

- [ ] **Step 6: Verify backfill + build**

Run (DB up, `DATABASE_URL` set): a quick check that the column exists and existing rows are backfilled — e.g.
`npx tsx -e "import{PrismaClient}from'@prisma/client';const d=new PrismaClient();const n=await d.agentSecret.count({where:{boundName:{equals:''}}});console.log('empty boundName rows:',n);await d.\$disconnect();"`
Expected: `0`. Then `npm run build`.
Expected: tsc passes.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/core/secrets.database.test.ts
git commit -m "feat(secrets): add boundName to AgentSecret (additive migration + backfill)"
```

---

### Task 2: Resolve secrets by `boundName` in `core/secrets.ts`

**Files:**
- Modify: `src/core/secrets.ts` (`attachSecret`, `detachSecret`, `buildSecretsAccessor`)
- Modify: `src/core/secrets.test.ts` (update `fakeDb`, update the detach test for the new signature, add binding-name tests)

**Interfaces:**
- Consumes: `AgentSecret.boundName` from Task 1.
- Produces:
  - `attachSecret(agentId: string, name: string, ownerId: string, db: PrismaClient, boundName?: string): Promise<void>` — `boundName` defaults to `name`.
  - `detachSecret(agentId: string, boundName: string, db: PrismaClient): Promise<void>` — **ownerId parameter removed.**
  - `buildSecretsAccessor(agentId, cipher, db)` — unchanged signature; `get(name)` now resolves by `boundName`.

- [ ] **Step 1: Update `fakeDb` in the test file to carry `boundName`**

In `src/core/secrets.test.ts`, change the `FakeAgentSecretRow` interface and the `agentSecret` double:

```ts
interface FakeAgentSecretRow {
  agentId: string;
  secretId: string;
  boundName: string;
}
```

```ts
    agentSecret: {
      create: async ({ data }: { data: FakeAgentSecretRow }) => {
        agentSecrets.push(data);
        return data;
      },
      deleteMany: async ({ where }: { where: { agentId: string; boundName: string } }) => {
        const before = agentSecrets.length;
        const kept = agentSecrets.filter((a) => !(a.agentId === where.agentId && a.boundName === where.boundName));
        agentSecrets.length = 0;
        agentSecrets.push(...kept);
        return { count: before - kept.length };
      },
      findFirst: async ({ where }: { where: { agentId: string; boundName: string } }) => {
        const match = agentSecrets.find((a) => a.agentId === where.agentId && a.boundName === where.boundName);
        if (!match) return null;
        return { ...match, secret: secrets.get(match.secretId) };
      },
    },
```

- [ ] **Step 2: Write the failing/updated tests**

Update the existing detach test to the new signature and add binding-name tests:

```ts
  it("detachSecret removes access", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    await createSecret("API_KEY", "sk-live-abc123", "p1", cipher, db);
    await attachSecret("agent-1", "API_KEY", "p1", db);
    await detachSecret("agent-1", "API_KEY", db); // now (agentId, boundName, db)

    const accessor = buildSecretsAccessor("agent-1", cipher, db);
    expect(await accessor.get("API_KEY")).toBeUndefined();
  });

  it("two agents resolve the same boundName to their own distinct secrets", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    await createSecret("bitbucket_aies", "token-aies", "p1", cipher, db);
    await createSecret("bitbucket_ondemand", "token-ondemand", "p1", cipher, db);
    await attachSecret("agent-A", "bitbucket_aies", "p1", db, "bitbucket");
    await attachSecret("agent-B", "bitbucket_ondemand", "p1", db, "bitbucket");

    expect(await buildSecretsAccessor("agent-A", cipher, db).get("bitbucket")).toBe("token-aies");
    expect(await buildSecretsAccessor("agent-B", cipher, db).get("bitbucket")).toBe("token-ondemand");
  });

  it("one agent resolves two secrets under two distinct boundNames", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    await createSecret("jira_chris", "jc", "p1", cipher, db);
    await createSecret("bitbucket_aies", "ba", "p1", cipher, db);
    await attachSecret("agent-1", "jira_chris", "p1", db, "jira");
    await attachSecret("agent-1", "bitbucket_aies", "p1", db, "bitbucket");

    const accessor = buildSecretsAccessor("agent-1", cipher, db);
    expect(await accessor.get("jira")).toBe("jc");
    expect(await accessor.get("bitbucket")).toBe("ba");
  });

  it("attachSecret defaults boundName to the secret name", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    await createSecret("API_KEY", "v", "p1", cipher, db);
    await attachSecret("agent-1", "API_KEY", "p1", db); // no boundName
    expect(await buildSecretsAccessor("agent-1", cipher, db).get("API_KEY")).toBe("v");
  });
```

Run: `npx vitest run src/core/secrets.test.ts`
Expected: FAIL (attachSecret has no 5th param yet; detach signature mismatch; get resolves by secret name).

- [ ] **Step 3: Implement the resolution change in `src/core/secrets.ts`**

Replace `attachSecret`, `detachSecret`, and the two resolution branches of `buildSecretsAccessor.get`:

```ts
/** Attaches one of the owner's own secrets (by canonical name) to an agent,
 *  under `boundName` — the point-of-use name the agent's tools resolve
 *  (`secrets.get(boundName)`). Defaults to the secret's own name. */
export async function attachSecret(
  agentId: string,
  name: string,
  ownerId: string,
  db: PrismaClient,
  boundName: string = name,
): Promise<void> {
  const secret = await findOwnedSecretByName(db, ownerId, name);
  if (!secret) throw new Error(`No secret named "${name}" owned by this caller.`);
  await db.agentSecret.create({ data: { agentId, secretId: secret.id, boundName } });
}

/** Detaches by point-of-use name — the pair (agentId, boundName) uniquely
 *  identifies the edge; agent ownership is enforced by the caller. */
export async function detachSecret(agentId: string, boundName: string, db: PrismaClient): Promise<void> {
  await db.agentSecret.deleteMany({ where: { agentId, boundName } });
}
```

In `buildSecretsAccessor.get`, the `$queryRaw` path WHERE clause:

```ts
          FROM "Secret" s JOIN "AgentSecret" a ON a."secretId" = s."id"
          WHERE a."agentId" = ${agentId} AND a."boundName" = ${name} LIMIT 1`;
```

and the Prisma-double fallback:

```ts
      const attachment = await db.agentSecret.findFirst({
        where: { agentId, boundName: name },
        include: { secret: true },
      });
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/core/secrets.test.ts`
Expected: PASS.

- [ ] **Step 4a: Update the sole production caller of `detachSecret` so the tree compiles**

`detachSecret` dropped its `ownerId` parameter, so its one production caller — the `detach_secret` MCP handler in `src/mcp/tools/secrets.ts` (~line 128) — must match or `npm run build` (tsc) fails. Change:

```ts
      await detachSecret(args.agentId, args.name, ctx.principal.id, ctx.db);
```
to:
```ts
      await detachSecret(args.agentId, args.name, ctx.db); // `name` is the point-of-use (bound) name
```

(The `attach_secret` caller is unaffected — `attachSecret`'s new `boundName` is a trailing optional, so the existing 4-arg call still compiles. Adding the optional `alias` input to `attach_secret` is Task 4.)

- [ ] **Step 5: Full build + commit**

Run: `npm run build`
Expected: tsc clean (proves the caller update in Step 4a is complete).

```bash
git add src/core/secrets.ts src/core/secrets.test.ts src/mcp/tools/secrets.ts
git commit -m "feat(secrets): resolve attachments by boundName, not secret name"
```

---

### Task 3: Real-DB resolution regression (gated on `DATABASE_URL`)

**Files:**
- Modify: `src/core/secrets.database.test.ts` (add one gated test that exercises the `$queryRaw` production path)

**Interfaces:**
- Consumes: `attachSecret(…, boundName)` and boundName-based `get()` from Task 2.

- [ ] **Step 1: Add the gated regression test**

Append inside the `describe.skipIf(!process.env.DATABASE_URL)(...)` block (use fresh random ids and clean them up in `afterAll`):

```ts
  it("two agents resolve the same boundName to distinct secrets via SQL", async () => {
    const a = "bn-a-" + randomUUID();
    const b = "bn-b-" + randomUUID();
    const sa = "bn-sa-" + randomUUID();
    const sb = "bn-sb-" + randomUUID();
    const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
    try {
      await db.agent.create({ data: { id: a, name: a, systemPrompt: "t", model: "t", budgetUsd: 1 } });
      await db.agent.create({ data: { id: b, name: b, systemPrompt: "t", model: "t", budgetUsd: 1 } });
      await db.secret.create({ data: { id: sa, name: sa, ciphertext: "token-a", keyId: "test" } });
      await db.secret.create({ data: { id: sb, name: sb, ciphertext: "token-b", keyId: "test" } });
      await db.agentSecret.create({ data: { agentId: a, secretId: sa, boundName: "bitbucket" } });
      await db.agentSecret.create({ data: { agentId: b, secretId: sb, boundName: "bitbucket" } });

      expect(await buildSecretsAccessor(a, cipher, db).get("bitbucket")).toBe("token-a");
      expect(await buildSecretsAccessor(b, cipher, db).get("bitbucket")).toBe("token-b");
    } finally {
      await db.agentSecret.deleteMany({ where: { agentId: { in: [a, b] } } });
      await db.secret.deleteMany({ where: { id: { in: [sa, sb] } } });
      await db.agent.deleteMany({ where: { id: { in: [a, b] } } });
    }
  });
```

- [ ] **Step 2: Run against the DB**

Run (DB up, `DATABASE_URL` set): `npx vitest run src/core/secrets.database.test.ts`
Expected: PASS (not skipped).

- [ ] **Step 3: Commit**

```bash
git add src/core/secrets.database.test.ts
git commit -m "test(secrets): real-DB regression for boundName resolution"
```

---

### Task 4: MCP surface — optional alias on `attach_secret`

**Files:**
- Modify: `src/mcp/tools/secrets.ts` (the `attach_secret` handler only, ~lines 99–116)

> **Note (RULING P1):** the `detach_secret` handler was already updated to the new `detachSecret` signature in Task 2, Step 4a. This task touches only `attach_secret`, adding the optional `alias`.

**Interfaces:**
- Consumes: `attachSecret(…, boundName?)` from Task 2.

- [ ] **Step 1: Add optional `alias` to `attach_secret` and pass it as `boundName`**

```ts
  mcp.registerTool({
    name: "attach_secret",
    scope: "secrets:write",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        name: { type: "string" },
        alias: { type: "string" }, // optional point-of-use name; defaults to `name`
      },
      required: ["agentId", "name"],
    },
    handler: async (args: { agentId: string; name: string; alias?: string }, ctx) => {
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      try {
        await attachSecret(args.agentId, args.name, ctx.principal.id, ctx.db, args.alias ?? args.name);
      } catch (err) {
        throw new McpError(404, err instanceof Error ? err.message : String(err));
      }
      return textResult({ attached: true });
    },
  });
```

- [ ] **Step 2: Build + run any MCP secret tests**

Run: `npm run build` then `npx vitest run src/mcp` (if MCP tests exist for secrets; otherwise the build is the gate).
Expected: PASS / tsc clean.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/secrets.ts
git commit -m "feat(mcp): attach_secret optional alias (point-of-use name)"
```

---

### Task 5: Importer — one row per base secret, attach with alias as `boundName`

**Files:**
- Modify: `src/import/create.ts` (Step 4 secrets create, ~lines 166–239; Step 5 attach, ~lines 241–259)
- Modify: `src/import/create.test.ts` (update `fakeDb` `agentSecret`; rewrite the envelope test's assertions)
- Modify: `src/import/create.database.test.ts` (add a gated F2 regression)

**Interfaces:**
- Consumes: `attachSecret(…, boundName)`, `createSecret` (unchanged).
- Produces: `ImportResult.secretsCreated` now equals the number of distinct base secrets created (one per bundle secret), not the number of createSecret calls.

- [ ] **Step 1: Rewrite Step 4 to create one row per base secret**

Replace the whole `secretMode === "envelope"` create block (the `secretAliasMap` fan-out) with:

```ts
  // Step 4: Secrets — one row per base secret, under its canonical name.
  if (secretMode === "envelope") {
    if (!hasOwner) {
      for (const s of bundle.readSecrets()) {
        warnings.push(`secret ${s.name}: skipped — secrets require an owner (public import)`);
      }
    } else if (!transferPrivateKey) {
      warnings.push("envelope mode requires transferPrivateKey, skipping secrets");
    } else {
      const owner = ownerId; // hasOwner guarantees non-null
      for (const s of bundle.readSecrets()) {
        if (!s.ciphertext) {
          warnings.push(`secret ${s.name}: no ciphertext in envelope mode, skipping`);
          continue;
        }
        let plaintext: string;
        try {
          // AAD is ALWAYS the base secret name (s.name), never an alias.
          plaintext = decryptTransferEnvelope(s.ciphertext, s.name, transferPrivateKey);
        } catch (err) {
          warnings.push(`secret ${s.name}: failed to decrypt (${err instanceof Error ? err.message : String(err)})`);
          continue;
        }
        try {
          await createSecret(s.name, plaintext, owner, cipher, db);
          secretsCreated++; // one per distinct base secret (fixes F1 over-count)
        } catch (err) {
          warnings.push(`secret ${s.name}: failed to create (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }
  } else {
    for (const s of bundle.readSecrets()) {
      pendingSecretReentry.push(s.name);
    }
  }
```

- [ ] **Step 2: Rewrite Step 5 to attach under the alias as `boundName`**

```ts
  // Step 5: Attach secrets (envelope mode only)
  if (secretMode === "envelope" && hasOwner) {
    const owner = ownerId;
    for (const as of bundle.readAgentSecrets()) {
      const agentId = agentIdMap.get(as.agentName);
      if (!agentId) continue;
      const boundName = as.alias ?? as.secretName;
      try {
        await attachSecret(agentId, as.secretName, owner, db, boundName);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          // Either an idempotent re-run, or two secrets bound to the same
          // point-of-use name for one agent (a bundle inconsistency). Surface it.
          warnings.push(`agent-secret ${as.agentName}: "${boundName}" already bound — skipped (re-run or duplicate binding)`);
          continue;
        }
        warnings.push(`agent-secret ${as.agentName}/${as.secretName}: failed to attach (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }
```

- [ ] **Step 3: Update the fake `agentSecret` double in `create.test.ts`**

The double's `create` already captures its argument into `calls.agentSecret`; no shape change is required for it to record `boundName`. Leave `findFirst: vi.fn(async () => null)` as-is.

- [ ] **Step 4: Rewrite the envelope test assertions**

Replace the body of the `"envelope mode: decrypts …"` test (lines ~70–100) so it asserts the new behavior — one base row, attachment carries the alias as `boundName`:

```ts
  it("envelope mode: decrypts with AAD=secretName, creates one base row, attaches under the alias", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const db = fakeDb();

    const ciphertext = seal("my-secret-value", "API_KEY", publicKey);

    const res = await createFromBundle(
      bundleWith({
        agents: [{ name: "test-agent" }],
        secrets: [{ name: "API_KEY", description: null, ownerEmail: null, ciphertext }],
        agentSecrets: [{ agentName: "test-agent", secretName: "API_KEY", alias: "AK" }],
      }),
      emptyRecon,
      { db, cipher, ownerId: "p1", defaultBudget: "5.00", secretMode: "envelope", transferPrivateKey: privateKey, allowOpenFetch: false } as any,
    );

    // One base-name secret row, counted once.
    expect(res.secretsCreated).toBe(1);
    expect(db.calls.secret).toHaveLength(1);
    expect((db.calls.secret[0] as any).where.ownerId_name.name).toBe("API_KEY");

    // Attachment carries the alias as the point-of-use boundName.
    expect(db.calls.agentSecret).toHaveLength(1);
    expect((db.calls.agentSecret[0] as any).data.boundName).toBe("AK");

    // No "created under both base name and alias" warning anymore.
    expect(res.warnings.some((w) => w.includes("created under both base name and alias"))).toBe(false);
  });
```

Run: `npx vitest run src/import/create.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the gated real-DB F2 regression to `create.database.test.ts`**

Add a second gated `it(...)` that imports two agents, two distinct base secrets both aliased to `bitbucket`, then reads each agent's secret back. Use envelope mode with a locally-generated transfer key and the `seal` helper pattern from `create.test.ts` (import `generateKeyPairSync` etc.), assert: `secretsCreated === 2`, two `Secret` rows exist under the base names, two `AgentSecret` rows exist with `boundName = "bitbucket"`, and `buildSecretsAccessor(agentId).get("bitbucket")` returns each agent's own token. Clean up all created rows in a `try/finally` (agents, secrets, agentSecrets) keyed on the test's random ids.

Run (DB up): `npx vitest run src/import/create.database.test.ts`
Expected: PASS (not skipped).

- [ ] **Step 6: Full verify + commit**

Run: `npm test && npm run build`
Expected: all pass (DB-gated tests run only with `DATABASE_URL`).

```bash
git add src/import/create.ts src/import/create.test.ts src/import/create.database.test.ts
git commit -m "fix(import): one Secret row per base secret; attach under alias as boundName (F1+F2)"
```

---

## Post-implementation validation (controller-run, after the branch is green)

Not a task — the final live-fire the whole change exists to prove:

1. `npm run db:up` and reset the disposable DB (fresh migrate deploy).
2. Re-run the real bundle import (`~/Downloads/agent-cron-bundle-2026-09-08.zip` → extracted dir) with `--owner` + envelope decrypt (transfer key in `docs/private/`, throwaway `SECRET_APP_KEY`), exactly as the earlier live-fire.
3. Re-run the F2 verifier (`.superpowers/sdd/2026-09-08-tier1-importer-plan/verify-f2.mts`): expect **0 orphaned secret rows**, and each `bitbucket_*` / `jira_*` base row attached to its own agents (no 49-agent `bitbucket` collapse).
4. Confirm the import report's secret count equals distinct base secrets (F1 fixed).

## Self-review notes

- **Spec coverage:** schema (Task 1) ✓, migration (Task 1) ✓, core attach/detach/get both paths (Task 2) ✓, MCP surface (Task 4) ✓, importer Steps 4/5 (Task 5) ✓, tests incl. the colliding-alias regression (Tasks 2/3/5) ✓, back-compat via defaulted `boundName` (Task 2) ✓.
- **Signature consistency:** `attachSecret` keeps `ownerId` (needed to find the owned secret) and adds trailing optional `boundName`; `detachSecret` drops `ownerId` (edge identified by `(agentId, boundName)`). All call sites updated: MCP (Task 4), importer (Task 5), tests (Tasks 2/3). `buildSecretsAccessor` signature is unchanged, so `src/core/runner.ts:173` needs no edit.
- **`scopeSecretsAccessor` / `AgentTool.allowedSecrets`:** unchanged — they already key on point-of-use names, which `get()` now resolves by; behavior stays consistent, no task needed.
