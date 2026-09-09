/**
 * Real-DB integration test for createFromBundle — gated on DATABASE_URL.
 * Proves end-to-end create against Postgres.
 */
import { describe, it, expect, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { Bundle } from "./bundle.js";
import type { Manifest, NeutralAgent, NeutralTool, NeutralAgentTool, NeutralSingleDatastore, NeutralWebhook, NeutralBudget } from "./neutral-schema.js";
import { preflight } from "./preflight.js";
import { createFromBundle } from "./create.js";
import { resolvePrincipal } from "../mcp/auth/principal.js";
import { buildSecretCipher } from "../providers/secrets/index.js";
import { loadProviderConfig } from "../config/providers.js";

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
    };

    const datastore: NeutralSingleDatastore = {
      agentName,
      name: undefined,
      entries: [
        { key: "test-key", value: { data: "test-value" }, pii: false },
      ],
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
});
