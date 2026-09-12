/**
 * Real-DB integration test for createFromBundle — gated on DATABASE_URL.
 * Proves end-to-end create against Postgres.
 */
import { describe, it, expect, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  randomUUID,
  generateKeyPairSync,
  diffieHellman,
  hkdfSync,
  randomBytes,
  createCipheriv,
  type KeyObject,
} from "node:crypto";
import type { Bundle } from "./bundle.js";
import type {
  Manifest,
  NeutralAgent,
  NeutralTool,
  NeutralAgentTool,
  NeutralSingleDatastore,
  NeutralSharedDatastore,
  NeutralWebhook,
  NeutralBudget,
  NeutralSecret,
  NeutralAgentSecret,
} from "./neutral-schema.js";
import { preflight } from "./preflight.js";
import { createFromBundle } from "./create.js";
import { resolvePrincipal } from "../mcp/auth/principal.js";
import { buildSecretCipher } from "../providers/secrets/index.js";
import { loadProviderConfig } from "../config/providers.js";
import { buildSecretsAccessor } from "../core/secrets.js";
import type { TransferEnvelope } from "../providers/secrets/transfer-envelope.js";

// Test-only sealer matching spec §5.3 (mirrors the exporter).
const INFO = Buffer.from("reevo-secret-transfer-v1");
const rawOf = (k: KeyObject) => (k.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);

function seal(plaintext: string, name: string, recipientPub: KeyObject): TransferEnvelope {
  const { privateKey: esk, publicKey: epk } = generateKeyPairSync("x25519");
  const epkRaw = rawOf(epk);
  const shared = diffieHellman({ privateKey: esk, publicKey: recipientPub });
  const okm = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epkRaw, rawOf(recipientPub)]), INFO, 32));
  const nonce = randomBytes(12);
  const c = createCipheriv("chacha20-poly1305", okm, nonce, { authTagLength: 16 });
  c.setAAD(Buffer.from(name, "utf8"), { plaintextLength: Buffer.byteLength(plaintext) });
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, "utf8")), c.final()]);
  return {
    v: 1,
    alg: "x25519-hkdf-sha256-chacha20poly1305-v1",
    epk: epkRaw.toString("hex"),
    nonce: nonce.toString("hex"),
    ct: ct.toString("hex"),
    tag: c.getAuthTag().toString("hex"),
  };
}

describe.skipIf(!process.env.DATABASE_URL)("createFromBundle (database)", () => {
  const db = new PrismaClient();
  const testId = randomUUID().slice(0, 8);
  const agentName = `test-agent-${testId}`;
  const toolName = `test-tool-${testId}`;
  const budgetName = `test-budget-${testId}`;
  const ownerSubject = `test-owner-${testId}`;

  afterAll(async () => {
    // Clean up test data
    const agent = await db.agent.findUnique({ where: { name: agentName } });
    if (agent) {
      await db.agentTool.deleteMany({ where: { agentId: agent.id } });
      await db.datastoreEntry.deleteMany({ where: { agentId: agent.id } });
      await db.webhook.deleteMany({ where: { agentId: agent.id } });
      await db.agent.deleteMany({ where: { id: agent.id } });
    }
    await db.tool.deleteMany({ where: { name: toolName } });
    await db.budgetGroup.deleteMany({ where: { name: budgetName } });
    await db.principal.deleteMany({ where: { subject: ownerSubject } });
    await db.$disconnect();
  });

  it("creates agent + tool + attachment + datastore + budget group + webhook", async () => {
    // Assemble minimal bundle
    const manifest: Manifest = {
      bundleVersion: 1,
      source: { product: "test", exporterVersion: "1.0", exportedAt: new Date().toISOString() },
      secretMode: "references",
      transferKeyId: null,
      contentWindowDays: null,
      contentSince: null,
      toolCallDetail: "metadata",
      runAuditWindowDays: null,
      runAuditSince: null,
      capabilities: [],
      counts: { agents: 1, tools: 1, budgets: 1 },
    };

    const agent: NeutralAgent = {
      name: agentName,
      systemPrompt: "Test agent",
      provider: "bedrock",
      model: "claude-opus-4",
      region: null,
      schedule: null,
      timezone: "UTC",
      scheduleEnabled: false,
      maxTurns: 10,
      budgetUsd: "5.00",
      ownerEmail: null,
      kind: "native",
      memoryEnabled: false,
      unmodeled: {},
    };

    const tool: NeutralTool = {
      name: toolName,
      description: "Test tool",
      paramsZod: "z.object({ input: z.string() })",
      jsonSchema: null,
      code: "async function run(params) { return { result: params.input }; }",
      secretSchema: "",
    };

    const agentTool: NeutralAgentTool = {
      agentName,
      toolName,
      allowedSecrets: [],
      allowedDatastorePrefixes: ["test:"],
      allowedHosts: ["example.com"],
      allowedSharedDatastorePrefixes: { kb: ["team:"] },
    };

    const datastore: NeutralSingleDatastore = {
      agentName,
      name: undefined,
      entries: [{ key: "test-key", value: { data: "test-value" }, pii: false }],
    };

    const webhook: NeutralWebhook = {
      agentName,
      enabled: true,
    };

    const budget: NeutralBudget = {
      name: budgetName,
      ownerEmail: null,
      period: "monthly",
      alertThreshold: "80.00",
      blockThreshold: "100.00",
      alertEmails: [],
      enabled: true,
      attachedAgentNames: [agentName],
    };

    const bundle: Bundle = {
      manifest,
      readAgents: () => [agent],
      readTools: () => [tool],
      readAgentTools: () => [agentTool],
      readSecrets: () => [],
      readAgentSecrets: () => [],
      readSingleDatastores: () => [datastore],
      readSharedDatastores: () => [],
      readWebhooks: () => [webhook],
      readBudgets: () => [budget],
    };

    // Resolve owner
    const owner = await resolvePrincipal(ownerSubject, db);
    const cipher = buildSecretCipher(loadProviderConfig());

    // Run preflight
    const existingAgents = await db.agent.findMany({ select: { name: true } });
    const existingTools = await db.tool.findMany({ select: { name: true } });
    const recon = preflight({
      bundle,
      routableModels: new Set(["claude-opus-4"]),
      supportedGlobals: new Set(),
      existingAgentNames: new Set(existingAgents.map((a) => a.name)),
      existingToolNames: new Set(existingTools.map((t) => t.name)),
      capabilitiesSupported: new Set([]),
      onConflict: "fail",
      prefix: "",
      allowOpenFetch: false,
    });

    expect(recon.hasFatalCollision).toBe(false);

    // Run createFromBundle
    const result = await createFromBundle(bundle, recon, {
      db,
      cipher,
      ownerId: owner.id,
      defaultBudget: "5.00",
      secretMode: "references",
      allowOpenFetch: false,
    });

    // Assert results
    expect(result.agentsCreated).toBe(1);
    expect(result.toolsCreated).toBe(1);
    expect(result.secretsCreated).toBe(0);
    expect(result.datastoreEntries).toBe(1);
    expect(result.budgetGroupsCreated).toBe(1);
    expect(result.webhookSecrets).toHaveLength(1);
    expect(result.webhookSecrets[0]?.agentName).toBe(agentName);
    expect(result.pendingSecretReentry).toHaveLength(0);

    // Verify rows exist
    const createdAgent = await db.agent.findUnique({
      where: { name: agentName },
      include: { tools: true, budgetGroup: true },
    });
    expect(createdAgent).toBeTruthy();
    expect(createdAgent?.systemPrompt).toBe("Test agent");
    expect(createdAgent?.tools).toHaveLength(1);
    expect(createdAgent?.budgetGroup?.name).toBe(budgetName);

    const createdTool = await db.tool.findUnique({ where: { name: toolName } });
    expect(createdTool).toBeTruthy();
    expect(createdTool?.description).toBe("Test tool");

    // allowedSharedDatastorePrefixes must actually reach the AgentTool row —
    // this is the importer's half of finding #1's write path (tools.ts's
    // attach_tool and cli.ts's `tool attach` are the other two).
    const createdAgentTool = await db.agentTool.findUnique({
      where: { agentId_toolId: { agentId: createdAgent!.id, toolId: createdTool!.id } },
    });
    expect(createdAgentTool?.allowedSharedDatastorePrefixes).toEqual({ kb: ["team:"] });

    const datastoreEntry = await db.datastoreEntry.findFirst({
      where: { agentId: createdAgent!.id, key: "test-key" },
    });
    expect(datastoreEntry).toBeTruthy();
    expect(datastoreEntry?.value).toEqual({ data: "test-value" });

    const webhook1 = await db.webhook.findFirst({
      where: { agent: { name: agentName } },
    });
    expect(webhook1).toBeTruthy();
    expect(webhook1?.status).toBe("enabled");

    const budgetGroup = await db.budgetGroup.findUnique({
      where: { ownerId_name: { ownerId: owner.id, name: budgetName } },
    });
    expect(budgetGroup).toBeTruthy();
    expect(budgetGroup?.monthlyBudgetUsd).not.toBeNull();
  });

  it("envelope mode: two distinct base secrets both aliased to 'bitbucket' attach to separate agents (F2 regression)", async () => {
    // Generate a transfer keypair
    const { privateKey, publicKey } = generateKeyPairSync("x25519");

    // Random IDs for this test (isolated from the first test)
    const testId2 = randomUUID().slice(0, 8);
    const agentNameA = `test-agent-a-${testId2}`;
    const agentNameB = `test-agent-b-${testId2}`;
    const secretNameA = `bitbucket_aies_${testId2}`;
    const secretNameB = `bitbucket_ondemand_${testId2}`;
    const ownerSubject2 = `test-owner-${testId2}`;

    const plaintextA = `token-for-aies-${testId2}`;
    const plaintextB = `token-for-ondemand-${testId2}`;

    const ciphertextA = seal(plaintextA, secretNameA, publicKey);
    const ciphertextB = seal(plaintextB, secretNameB, publicKey);

    const manifest: Manifest = {
      bundleVersion: 1,
      source: { product: "test", exporterVersion: "1.0", exportedAt: new Date().toISOString() },
      secretMode: "envelope",
      transferKeyId: "test-key",
      contentWindowDays: null,
      contentSince: null,
      toolCallDetail: "metadata",
      runAuditWindowDays: null,
      runAuditSince: null,
      capabilities: [],
      counts: { agents: 2, tools: 0, budgets: 0 },
    };

    const agentA: NeutralAgent = {
      name: agentNameA,
      systemPrompt: "Test agent A",
      provider: "bedrock",
      model: "claude-opus-4",
      region: null,
      schedule: null,
      timezone: "UTC",
      scheduleEnabled: false,
      maxTurns: 10,
      budgetUsd: "5.00",
      ownerEmail: null,
      kind: "native",
      memoryEnabled: false,
      unmodeled: {},
    };

    const agentB: NeutralAgent = {
      name: agentNameB,
      systemPrompt: "Test agent B",
      provider: "bedrock",
      model: "claude-opus-4",
      region: null,
      schedule: null,
      timezone: "UTC",
      scheduleEnabled: false,
      maxTurns: 10,
      budgetUsd: "5.00",
      ownerEmail: null,
      kind: "native",
      memoryEnabled: false,
      unmodeled: {},
    };

    const secretA: NeutralSecret = {
      name: secretNameA,
      description: null,
      ownerEmail: null,
      ciphertext: ciphertextA,
    };

    const secretB: NeutralSecret = {
      name: secretNameB,
      description: null,
      ownerEmail: null,
      ciphertext: ciphertextB,
    };

    const agentSecretA: NeutralAgentSecret = {
      agentName: agentNameA,
      secretName: secretNameA,
      alias: "bitbucket",
    };

    const agentSecretB: NeutralAgentSecret = {
      agentName: agentNameB,
      secretName: secretNameB,
      alias: "bitbucket",
    };

    const bundle: Bundle = {
      manifest,
      readAgents: () => [agentA, agentB],
      readTools: () => [],
      readAgentTools: () => [],
      readSecrets: () => [secretA, secretB],
      readAgentSecrets: () => [agentSecretA, agentSecretB],
      readSingleDatastores: () => [],
      readSharedDatastores: () => [],
      readWebhooks: () => [],
      readBudgets: () => [],
    };

    const cipher = buildSecretCipher(loadProviderConfig());

    let owner: { id: string } | undefined;
    let agentIdA: string | undefined;
    let agentIdB: string | undefined;

    try {
      // Resolve owner
      owner = await resolvePrincipal(ownerSubject2, db);

      // Run preflight
      const existingAgents = await db.agent.findMany({ select: { name: true } });
      const existingTools = await db.tool.findMany({ select: { name: true } });
      const recon = preflight({
        bundle,
        routableModels: new Set(["claude-opus-4"]),
        supportedGlobals: new Set(),
        existingAgentNames: new Set(existingAgents.map((a) => a.name)),
        existingToolNames: new Set(existingTools.map((t) => t.name)),
        capabilitiesSupported: new Set([]),
        onConflict: "fail",
        prefix: "",
        allowOpenFetch: false,
      });

      expect(recon.hasFatalCollision).toBe(false);

      // Run createFromBundle
      const result = await createFromBundle(bundle, recon, {
        db,
        cipher,
        ownerId: owner.id,
        defaultBudget: "5.00",
        secretMode: "envelope",
        transferPrivateKey: privateKey,
        allowOpenFetch: false,
      });

      // Assert: two distinct base secrets created (F1 fix)
      expect(result.secretsCreated).toBe(2);

      // Verify two Secret rows exist under the base names
      const secretRowA = await db.secret.findUnique({
        where: { ownerId_name: { ownerId: owner.id, name: secretNameA } },
      });
      const secretRowB = await db.secret.findUnique({
        where: { ownerId_name: { ownerId: owner.id, name: secretNameB } },
      });
      expect(secretRowA).toBeTruthy();
      expect(secretRowB).toBeTruthy();

      // Verify two AgentSecret rows exist with boundName = "bitbucket"
      const createdAgentA = await db.agent.findUnique({ where: { name: agentNameA } });
      const createdAgentB = await db.agent.findUnique({ where: { name: agentNameB } });
      expect(createdAgentA).toBeTruthy();
      expect(createdAgentB).toBeTruthy();

      agentIdA = createdAgentA!.id;
      agentIdB = createdAgentB!.id;

      const agentSecretRowA = await db.agentSecret.findUnique({
        where: { agentId_boundName: { agentId: agentIdA, boundName: "bitbucket" } },
      });
      const agentSecretRowB = await db.agentSecret.findUnique({
        where: { agentId_boundName: { agentId: agentIdB, boundName: "bitbucket" } },
      });
      expect(agentSecretRowA).toBeTruthy();
      expect(agentSecretRowB).toBeTruthy();

      // Verify each agent reads its own distinct plaintext (F2 fix)
      const accessorA = buildSecretsAccessor(agentIdA, cipher, db);
      const accessorB = buildSecretsAccessor(agentIdB, cipher, db);

      const retrievedA = await accessorA.get("bitbucket");
      const retrievedB = await accessorB.get("bitbucket");

      expect(retrievedA).toBe(plaintextA);
      expect(retrievedB).toBe(plaintextB);
    } finally {
      // Clean up all created rows
      if (agentIdA) {
        await db.agentSecret.deleteMany({ where: { agentId: agentIdA } });
        await db.agent.deleteMany({ where: { id: agentIdA } });
      }
      if (agentIdB) {
        await db.agentSecret.deleteMany({ where: { agentId: agentIdB } });
        await db.agent.deleteMany({ where: { id: agentIdB } });
      }
      if (owner) {
        await db.secret.deleteMany({
          where: {
            ownerId: owner.id,
            name: { in: [secretNameA, secretNameB] },
          },
        });
        await db.principal.deleteMany({ where: { subject: ownerSubject2 } });
      }
    }
  });

  it("creates a shared datastore, seeds its entries, and attaches it to two agents", async () => {
    const testId3 = randomUUID().slice(0, 8);
    const agentNameA = `test-shared-a-${testId3}`;
    const agentNameB = `test-shared-b-${testId3}`;
    const sharedName = `shared-kb-${testId3}`;
    const ownerSubject3 = `test-owner-shared-${testId3}`;

    const mkAgent = (name: string): NeutralAgent => ({
      name,
      systemPrompt: "Test agent",
      provider: "bedrock",
      model: "claude-opus-4",
      region: null,
      schedule: null,
      timezone: "UTC",
      scheduleEnabled: false,
      maxTurns: 10,
      budgetUsd: "5.00",
      ownerEmail: null,
      kind: "native",
      memoryEnabled: false,
      unmodeled: {},
    });

    const manifest: Manifest = {
      bundleVersion: 1,
      source: { product: "test", exporterVersion: "1.0", exportedAt: new Date().toISOString() },
      secretMode: "references",
      transferKeyId: null,
      contentWindowDays: null,
      contentSince: null,
      toolCallDetail: "metadata",
      runAuditWindowDays: null,
      runAuditSince: null,
      capabilities: [],
      counts: { agents: 2 },
    };

    const agentA = mkAgent(agentNameA);
    const agentB = mkAgent(agentNameB);

    const sharedDatastore: NeutralSharedDatastore = {
      name: sharedName,
      ownerEmail: null,
      attachedAgentNames: [agentNameA, agentNameB],
      entries: [{ key: "k1", value: { hello: "world" } }],
    };

    const bundle: Bundle = {
      manifest,
      readAgents: () => [agentA, agentB],
      readTools: () => [],
      readAgentTools: () => [],
      readSecrets: () => [],
      readAgentSecrets: () => [],
      readSingleDatastores: () => [],
      readSharedDatastores: () => [sharedDatastore],
      readWebhooks: () => [],
      readBudgets: () => [],
    };

    let owner: { id: string } | undefined;
    let agentIdA: string | undefined;
    let agentIdB: string | undefined;
    let datastoreId: string | undefined;

    try {
      owner = await resolvePrincipal(ownerSubject3, db);
      const cipher = buildSecretCipher(loadProviderConfig());

      const recon = preflight({
        bundle,
        routableModels: new Set(["claude-opus-4"]),
        supportedGlobals: new Set(),
        existingAgentNames: new Set(),
        existingToolNames: new Set(),
        capabilitiesSupported: new Set(["shared-datastores"]),
        onConflict: "fail",
        prefix: "",
        allowOpenFetch: false,
      });
      expect(recon.hasFatalCollision).toBe(false);

      const result = await createFromBundle(bundle, recon, {
        db,
        cipher,
        ownerId: owner.id,
        defaultBudget: "5.00",
        secretMode: "references",
        allowOpenFetch: false,
      });

      expect(result.datastoresSharedCreated).toBe(1);

      const createdAgentA = await db.agent.findUnique({ where: { name: agentNameA } });
      const createdAgentB = await db.agent.findUnique({ where: { name: agentNameB } });
      expect(createdAgentA).toBeTruthy();
      expect(createdAgentB).toBeTruthy();
      agentIdA = createdAgentA!.id;
      agentIdB = createdAgentB!.id;

      const created = await db.datastore.findFirstOrThrow({
        where: { name: sharedName, ownerId: owner.id },
      });
      datastoreId = created.id;

      const attachments = await db.agentDatastore.findMany({ where: { datastoreId: created.id } });
      expect(attachments).toHaveLength(2);
      expect(attachments.map((a) => a.boundName).sort()).toEqual([sharedName, sharedName]);
      expect(attachments.map((a) => a.agentId).sort()).toEqual([agentIdA, agentIdB].sort());

      const entries = await db.datastoreEntry.findMany({ where: { datastoreId: created.id } });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.key).toBe("k1");
      expect(entries[0]?.value).toEqual({ hello: "world" });
    } finally {
      if (datastoreId) {
        await db.agentDatastore.deleteMany({ where: { datastoreId } });
        await db.datastoreEntry.deleteMany({ where: { datastoreId } });
        await db.datastore.deleteMany({ where: { id: datastoreId } });
      }
      if (agentIdA) await db.agent.deleteMany({ where: { id: agentIdA } });
      if (agentIdB) await db.agent.deleteMany({ where: { id: agentIdB } });
      if (owner) await db.principal.deleteMany({ where: { subject: ownerSubject3 } });
    }
  });

  it("a boundName collision across two same-named shared stores on one agent warns instead of throwing", async () => {
    // createDatastore (Task 3) is a plain create, not an upsert (deliberate,
    // per progress.md's Task 3 note) — two shared-datastore definitions with
    // the same name for the same owner collide on Datastore's own
    // @@unique([ownerId, name]) at creation time, before either ever reaches
    // attachDatastore's @@unique([agentId, boundName]). Either constraint
    // firing must warn-and-skip rather than aborting the whole import; this
    // test proves the first definition still succeeds end-to-end and the
    // second is skipped with a warning naming it.
    const testId4 = randomUUID().slice(0, 8);
    const agentName = `test-shared-collision-${testId4}`;
    const sharedName = `kb-${testId4}`;
    const ownerSubject4 = `test-owner-shared-collision-${testId4}`;

    const agent: NeutralAgent = {
      name: agentName,
      systemPrompt: "Test agent",
      provider: "bedrock",
      model: "claude-opus-4",
      region: null,
      schedule: null,
      timezone: "UTC",
      scheduleEnabled: false,
      maxTurns: 10,
      budgetUsd: "5.00",
      ownerEmail: null,
      kind: "native",
      memoryEnabled: false,
      unmodeled: {},
    };

    const manifest: Manifest = {
      bundleVersion: 1,
      source: { product: "test", exporterVersion: "1.0", exportedAt: new Date().toISOString() },
      secretMode: "references",
      transferKeyId: null,
      contentWindowDays: null,
      contentSince: null,
      toolCallDetail: "metadata",
      runAuditWindowDays: null,
      runAuditSince: null,
      capabilities: [],
      counts: { agents: 1 },
    };

    const sharedDatastoreDup: NeutralSharedDatastore = {
      name: sharedName,
      ownerEmail: null,
      attachedAgentNames: [agentName],
      entries: [],
    };

    const bundle: Bundle = {
      manifest,
      readAgents: () => [agent],
      readTools: () => [],
      readAgentTools: () => [],
      readSecrets: () => [],
      readAgentSecrets: () => [],
      readSingleDatastores: () => [],
      readSharedDatastores: () => [sharedDatastoreDup, sharedDatastoreDup],
      readWebhooks: () => [],
      readBudgets: () => [],
    };

    let owner: { id: string } | undefined;
    let agentId: string | undefined;
    let datastoreId: string | undefined;

    try {
      owner = await resolvePrincipal(ownerSubject4, db);
      const cipher = buildSecretCipher(loadProviderConfig());

      const recon = preflight({
        bundle,
        routableModels: new Set(["claude-opus-4"]),
        supportedGlobals: new Set(),
        existingAgentNames: new Set(),
        existingToolNames: new Set(),
        capabilitiesSupported: new Set(["shared-datastores"]),
        onConflict: "fail",
        prefix: "",
        allowOpenFetch: false,
      });
      expect(recon.hasFatalCollision).toBe(false);

      const result = await createFromBundle(bundle, recon, {
        db,
        cipher,
        ownerId: owner.id,
        defaultBudget: "5.00",
        secretMode: "references",
        allowOpenFetch: false,
      });

      // Only the first "kb" definition actually creates a row; the second
      // collides on (ownerId, name) and is skipped with a warning — it must
      // not throw and abort the whole import.
      expect(result.datastoresSharedCreated).toBe(1);
      expect(result.warnings.some((w) => w.includes(sharedName))).toBe(true);

      const createdAgent = await db.agent.findUnique({ where: { name: agentName } });
      expect(createdAgent).toBeTruthy();
      agentId = createdAgent!.id;

      const rows = await db.datastore.findMany({ where: { name: sharedName, ownerId: owner.id } });
      expect(rows).toHaveLength(1);
      datastoreId = rows[0].id;

      const attachments = await db.agentDatastore.findMany({ where: { datastoreId } });
      expect(attachments).toHaveLength(1);
      expect(attachments[0]?.boundName).toBe(sharedName);
    } finally {
      if (datastoreId) {
        await db.agentDatastore.deleteMany({ where: { datastoreId } });
        await db.datastore.deleteMany({ where: { id: datastoreId } });
      }
      if (agentId) await db.agent.deleteMany({ where: { id: agentId } });
      if (owner) await db.principal.deleteMany({ where: { subject: ownerSubject4 } });
    }
  });
});
