import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./db.js";
import { NativeEngine } from "./engine-native.js";
import { executeRun, type NativeRunProviders } from "./runner.js";
import { createDbSecretWriteGuard } from "./secret-guard.js";
import { guardAgentMemory, guardDatastore } from "./secret-guarded-stores.js";
import { identityCipher, MODEL, noMemory, scriptedModel, usage } from "../native-worker/fixtures.test-support.js";
import { loopbackLauncher } from "../native-worker/loopback.js";
import { PostgresDatastore } from "../providers/datastore/index.js";
import type { LlmStreamEvent } from "../providers/llm/types.js";

const SECRET_VALUE = "fake-secret-value-1234";

const call = (id: string, name: string): LlmStreamEvent[] => [
  { type: "tool_call", id, name, argsJson: "{}" },
  { type: "done", stopReason: "tool_use", usage: usage(400, 30) },
];

describe.skipIf(!process.env.DATABASE_URL)("a stored secret is refused and never read back (database)", () => {
  const db = createPrismaClient();
  const tag = randomUUID().slice(0, 8);
  const ownerId = `readback-owner-${tag}`;
  const agentId = `readback-agent-${tag}`;
  const secretId = `readback-secret-${tag}`;
  const toolIds = { write: `readback-write-${tag}`, read: `readback-read-${tag}` };

  afterAll(async () => {
    const runs = await db.run.findMany({ where: { agentId }, select: { id: true } });
    const runIds = runs.map((r) => r.id);
    await db.runModelUsage.deleteMany({ where: { runId: { in: runIds } } });
    await db.runAttribution.deleteMany({ where: { runId: { in: runIds } } });
    await db.run.deleteMany({ where: { id: { in: runIds } } });
    await db.datastoreEntry.deleteMany({ where: { agentId } });
    await db.agentTool.deleteMany({ where: { agentId } });
    await db.agentSecret.deleteMany({ where: { agentId } });
    await db.secret.deleteMany({ where: { id: secretId } });
    await db.tool.deleteMany({ where: { id: { in: Object.values(toolIds) } } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
  });

  async function seed() {
    await db.principal.create({ data: { id: ownerId, subject: ownerId } });
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "Test.", model: MODEL, budgetUsd: 1, maxTurns: 6, ownerId },
    });
    const schema = { type: "object", properties: {}, required: [] };
    const tools = [
      {
        id: toolIds.write,
        name: "write_key",
        code: `
          try {
            await datastore.set("notes/k", await secrets.get("API_KEY"));
            return { stored: true };
          } catch (e) {
            return { stored: false, message: String(e.message) };
          }`,
        allowedSecrets: ["API_KEY"],
      },
      {
        id: toolIds.read,
        name: "read_key",
        code: `return { value: (await datastore.get("notes/k")) ?? null };`,
        allowedSecrets: [],
      },
    ];
    for (const t of tools) {
      await db.tool.create({
        data: {
          id: t.id,
          name: t.name,
          description: t.name,
          paramsZod: "z.object({})",
          jsonSchema: schema,
          code: t.code,
          ownerId,
        },
      });
      await db.agentTool.create({
        data: {
          agentId,
          toolId: t.id,
          allowedSecrets: t.allowedSecrets,
          allowedDatastorePrefixes: ["notes/"],
          capabilitiesGrantedById: ownerId,
        },
      });
    }
    await db.secret.create({
      data: { id: secretId, name: "api", ciphertext: SECRET_VALUE, keyId: "test", ownerId },
    });
    await db.agentSecret.create({ data: { agentId, secretId, boundName: "API_KEY" } });
  }

  it.each(["control_plane", "sandbox"] as const)("in %s mode", async (mode) => {
    if (mode === "control_plane") await seed();
    const turns: LlmStreamEvent[][] = [
      call("c1", "write_key"),
      call("c2", "read_key"),
      [
        { type: "text", delta: "done" },
        { type: "done", stopReason: "end_turn", usage: usage(500, 10) },
      ],
    ];
    const { llm, requests } = scriptedModel(turns);
    const guard = createDbSecretWriteGuard(db, identityCipher);
    const providers: NativeRunProviders = {
      llm,
      engine: new NativeEngine(),
      datastore: guardDatastore(new PostgresDatastore(db, identityCipher), guard),
      secrets: identityCipher,
      memory: guardAgentMemory(noMemory, guard),
      nativeSandbox: loopbackLauncher,
    };
    const run = await db.run.create({ data: { agentId, trigger: "manual", nativeExecutionMode: mode } });
    const finished = await executeRun(run.id, providers, db);
    expect(finished.status).toBe("succeeded");

    const toolResults = requests
      .flatMap((r) => r.messages)
      .filter((m) => m.role === "tool")
      .map((m) => String(m.content));
    const writeResult = toolResults.find((t) => t.includes("stored"));
    expect(writeResult).toContain("secret_in_value");
    expect(writeResult).toContain("API_KEY");
    expect(toolResults.some((t) => t.includes('"value":null'))).toBe(true);
    expect(JSON.stringify(requests)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(finished)).not.toContain(SECRET_VALUE);
    expect(await db.datastoreEntry.count({ where: { agentId, key: "notes/k" } })).toBe(0);
  });
});
