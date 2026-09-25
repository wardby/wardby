/**
 * Real-PostgreSQL parity tests for the Prisma 7 driver adapter
 * (@prisma/adapter-pg): the Prisma error codes wardby branches on still
 * arrive, through the actual call sites, and the retry that depends on
 * recognising a serialization failure still fires.
 *
 * Every row this file creates starts with PREFIX, so beforeAll/afterAll can
 * clear leftovers of an aborted earlier run. The only coding data is one
 * CodingAgentProfile (the P2014 test), never a CodingRun, so nothing here
 * perturbs the global slot/queue state coding-concurrency.database.test.ts
 * depends on.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "#prisma";
import type { PrismaClient } from "#prisma";
import { createPrismaClient } from "./db.js";
import { dispatchRun, isSerializationConflict } from "./dispatch.js";
import { attachSecret } from "./secrets.js";
import type { Executor } from "../providers/executor/types.js";
import type { McpRequestContext } from "../mcp/context.js";
import { McpError } from "../mcp/errors.js";
import type { WardbyMcpServer } from "../mcp/server.js";
import { registerAgentTools } from "../mcp/tools/agents.js";
import { registerDatastoreTools } from "../mcp/tools/datastore.js";
import { registerSchedulingTools } from "../mcp/tools/scheduling.js";
import { registerSubAgentTools } from "../mcp/tools/subagents.js";
import { registerToolAuthoringTools } from "../mcp/tools/tools.js";

const db = createPrismaClient();
const PREFIX = "pad-";
const suffix = randomUUID();
const id = (name: string) => `${PREFIX}${name}-${suffix}`;
const principalId = id("principal");

async function cleanupByPrefix(): Promise<void> {
  const where = { startsWith: PREFIX };
  await db.run.deleteMany({ where: { agentId: where } });
  await db.agentTool.deleteMany({ where: { agentId: where } });
  await db.agentDatastore.deleteMany({ where: { agentId: where } });
  await db.agentSecret.deleteMany({ where: { agentId: where } });
  await db.agentSubAgent.deleteMany({ where: { parentAgentId: where } });
  await db.tool.deleteMany({ where: { id: where } });
  await db.datastoreEntry.deleteMany({ where: { datastore: { name: where } } });
  await db.datastore.deleteMany({ where: { name: where } });
  await db.secret.deleteMany({ where: { name: where } });
  await db.agent.deleteMany({ where: { id: where } });
  await db.principal.deleteMany({ where: { id: where } });
}

async function createAgent(name: string): Promise<string> {
  const agentId = id(name);
  await db.agent.create({
    data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: principalId },
  });
  return agentId;
}

const noopExecutor: Executor = {
  async start() {},
  async stop() {},
};

type Handler = (args: never, ctx: McpRequestContext) => Promise<unknown>;

/** The real MCP tool handlers, captured without a transport. */
function mcpHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const mcp = {
    registerTool: (spec: { name: string; handler: Handler }) => handlers.set(spec.name, spec.handler),
  } as unknown as WardbyMcpServer;
  registerAgentTools(mcp);
  registerDatastoreTools(mcp);
  registerSchedulingTools(mcp);
  registerSubAgentTools(mcp);
  registerToolAuthoringTools(mcp);
  return handlers;
}

const handlers = mcpHandlers();

function ctx(database: PrismaClient = db): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(["agents:write", "agents:read", "tools:write", "datastore:write"]),
    canonicalUri: "https://host/mcp",
    providers: {} as McpRequestContext["providers"],
    db: database,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
}

async function callTool(name: string, args: Record<string, unknown>, database: PrismaClient = db): Promise<unknown> {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`no handler registered for ${name}`);
  return handler(args as never, ctx(database));
}

/**
 * `db`, except that inside every interactive transaction the first
 * `tx.<model>.<method>` call (default `tx.agent.findUnique`) runs `interleave`
 * (on a separate connection) right after it returns. That places a concurrent
 * committed write at a chosen point inside the transaction -- a genuine,
 * deterministic serialization conflict inside the code under test's own
 * Serializable transaction.
 */
function interleavedDb(
  interleave: () => Promise<unknown>,
  at: { model: "agent" | "run"; method: string } = { model: "agent", method: "findUnique" },
): PrismaClient {
  let fired = false;
  const bind = (target: object, prop: string | symbol) => {
    const value: unknown = Reflect.get(target, prop);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== "$transaction") return bind(target, prop);
      return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) =>
        target.$transaction(async (tx) => {
          const delegate = new Proxy(tx[at.model], {
            get(real, p) {
              const method = bind(real, p);
              if (p !== at.method || typeof method !== "function") return method;
              return async (...args: unknown[]) => {
                const result: unknown = await (method as (...a: unknown[]) => Promise<unknown>)(...args);
                if (!fired) {
                  fired = true;
                  await interleave();
                }
                return result;
              };
            },
          });
          return fn(new Proxy(tx, { get: (t, p) => (p === at.model ? delegate : bind(t, p)) }));
        }, options);
    },
  });
}

/** The McpError a promise rejects with. */
async function mcpError(promise: Promise<unknown>): Promise<McpError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(McpError);
  return err as McpError;
}

/** The PrismaClientKnownRequestError a promise rejects with (fails the test if it resolves or throws anything else). */
async function knownError(promise: Promise<unknown>): Promise<Prisma.PrismaClientKnownRequestError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  return err as Prisma.PrismaClientKnownRequestError;
}

describe.skipIf(!process.env.DATABASE_URL)("Prisma 7 adapter parity (PostgreSQL)", () => {
  beforeAll(async () => {
    await cleanupByPrefix();
    await db.principal.create({ data: { id: principalId, subject: principalId } });
  });

  afterAll(async () => {
    await cleanupByPrefix();
    await db.$disconnect();
  });

  describe("dispatchRun serialization retry", () => {
    it("retries when a genuine serialization failure surfaces on a raw statement inside its transaction", async () => {
      const agentId = await createAgent("raw-conflict");
      let attempts = 0;
      const result = await dispatchRun({
        db,
        executor: noopExecutor,
        agentId,
        beforePersist: async (tx) => {
          attempts += 1;
          if (attempts === 1) {
            // The transaction's snapshot already includes the agent row
            // (dispatchRun read it). A concurrent writer commits a change to
            // that row, then this Serializable transaction writes it with raw
            // SQL: PostgreSQL rejects the write with 40001 ("could not
            // serialize access due to concurrent update").
            await db.$executeRaw`UPDATE "Agent" SET "systemPrompt" = 'concurrent' WHERE "id" = ${agentId}`;
            await tx.$queryRaw`UPDATE "Agent" SET "systemPrompt" = 'in-tx' WHERE "id" = ${agentId} RETURNING "id"`;
          }
          return true;
        },
      });
      expect(attempts).toBe(2);
      expect(result?.run.agentId).toBe(agentId);
      expect(await db.run.count({ where: { agentId } })).toBe(1);
    });

    it("retries a serialization failure on a model statement (P2034), as before", async () => {
      const agentId = await createAgent("model-conflict");
      let attempts = 0;
      const result = await dispatchRun({
        db,
        executor: noopExecutor,
        agentId,
        beforePersist: async (tx) => {
          attempts += 1;
          if (attempts === 1) {
            await db.agent.update({ where: { id: agentId }, data: { systemPrompt: "concurrent" } });
            await tx.agent.update({ where: { id: agentId }, data: { systemPrompt: "in-tx" } });
          }
          return true;
        },
      });
      expect(attempts).toBe(2);
      expect(result?.run.agentId).toBe(agentId);
    });

    it("gives up after three conflicting attempts and rethrows the serialization failure", async () => {
      const agentId = await createAgent("always-conflict");
      let attempts = 0;
      const err = await knownError(
        dispatchRun({
          db,
          executor: noopExecutor,
          agentId,
          beforePersist: async (tx) => {
            attempts += 1;
            await db.$executeRaw`UPDATE "Agent" SET "systemPrompt" = ${`concurrent-${attempts}`} WHERE "id" = ${agentId}`;
            await tx.$queryRaw`UPDATE "Agent" SET "systemPrompt" = 'in-tx' WHERE "id" = ${agentId} RETURNING "id"`;
            return true;
          },
        }),
      );
      expect(attempts).toBe(3);
      expect(err.code).toBe("P2010");
      expect(isSerializationConflict(err)).toBe(true);
      expect(await db.run.count({ where: { agentId } })).toBe(0);
    });

    it("retries a serialization failure raised at COMMIT (write skew)", async () => {
      const agentId = await createAgent("skew-a");
      const otherId = await createAgent("skew-b");
      // T1 (dispatchRun's transaction) reads A and B and writes A. Right after
      // its last statement (run.create), T2 reads A, writes B and commits.
      // No T1 statement fails: PostgreSQL detects the read/write cycle and
      // rejects T1 at COMMIT with 40001.
      let t2Commits = 0;
      const skewed = interleavedDb(
        async () => {
          await db.$transaction(
            async (t2) => {
              await t2.agent.findUnique({ where: { id: agentId } });
              await t2.agent.update({ where: { id: otherId }, data: { systemPrompt: "t2" } });
            },
            { isolationLevel: "Serializable" },
          );
          t2Commits += 1;
        },
        { model: "run", method: "create" },
      );
      let attempts = 0;
      const result = await dispatchRun({
        db: skewed,
        executor: noopExecutor,
        agentId,
        beforePersist: async (tx) => {
          attempts += 1;
          await tx.agent.findUnique({ where: { id: otherId } });
          await tx.agent.update({ where: { id: agentId }, data: { systemPrompt: `t1-${attempts}` } });
          return true;
        },
      });
      expect(t2Commits).toBe(1);
      expect(attempts).toBe(2);
      expect(result?.run.agentId).toBe(agentId);
      expect(await db.run.count({ where: { agentId } })).toBe(1);
    });

    it("retries a deadlock (40P01) on a raw statement", async () => {
      const agentId = await createAgent("deadlock-a");
      const otherId = await createAgent("deadlock-b");
      let attempts = 0;
      let t2: Promise<unknown> | undefined;
      const result = await dispatchRun({
        db,
        executor: noopExecutor,
        agentId,
        beforePersist: async (tx) => {
          attempts += 1;
          if (attempts === 1) {
            // T2 locks B; T1 locks A then waits on B; 200 ms later T2 waits
            // on A. T1 started waiting first, so its deadlock_timeout (1 s by
            // default) fires first and PostgreSQL aborts T1 with 40P01.
            let lockedB!: () => void;
            const bLocked = new Promise<void>((resolve) => (lockedB = resolve));
            let openGate!: () => void;
            const gate = new Promise<void>((resolve) => (openGate = resolve));
            t2 = db.$transaction(async (other) => {
              await other.$executeRaw`UPDATE "Agent" SET "systemPrompt" = 't2' WHERE "id" = ${otherId}`;
              lockedB();
              await gate;
              await other.$executeRaw`UPDATE "Agent" SET "systemPrompt" = 't2' WHERE "id" = ${agentId}`;
            });
            await bLocked;
            await tx.$queryRaw`UPDATE "Agent" SET "systemPrompt" = 't1' WHERE "id" = ${agentId} RETURNING "id"`;
            setTimeout(openGate, 200);
            await tx.$queryRaw`UPDATE "Agent" SET "systemPrompt" = 't1' WHERE "id" = ${otherId} RETURNING "id"`;
          }
          return true;
        },
      });
      await t2;
      expect(attempts).toBe(2);
      expect(result?.run.agentId).toBe(agentId);
    });

    it("does not retry a raw-query failure that is not a serialization conflict", async () => {
      const agentId = await createAgent("raw-other");
      let attempts = 0;
      const err = await knownError(
        dispatchRun({
          db,
          executor: noopExecutor,
          agentId,
          beforePersist: async (tx) => {
            attempts += 1;
            await tx.$queryRaw`SELECT 1 FROM "pad-no_such_table"`;
            return true;
          },
        }),
      );
      expect(attempts).toBe(1);
      expect(err.code).toBe("P2010");
      expect(isSerializationConflict(err)).toBe(false);
    });
  });

  describe("error codes wardby branches on arrive through the adapter", () => {
    it("P2002 (unique): create_datastore, attach_datastore, attach_subagent map it to 409; attachSecret raises it for the import path", async () => {
      const name = id("ds-dup");
      await callTool("create_datastore", { name });
      expect((await mcpError(callTool("create_datastore", { name }))).httpStatus).toBe(409);

      const agentId = await createAgent("p2002-agent");
      const other = await db.datastore.create({ data: { name: id("ds-other"), ownerId: principalId } });
      const first = await db.datastore.findFirstOrThrow({ where: { name } });
      await callTool("attach_datastore", { agentId, datastoreId: first.id, boundName: "kb" });
      const dupBinding = await mcpError(
        callTool("attach_datastore", { agentId, datastoreId: other.id, boundName: "kb" }),
      );
      expect(dupBinding.httpStatus).toBe(409);

      const childA = await createAgent("p2002-child-a");
      const childB = await createAgent("p2002-child-b");
      await callTool("attach_subagent", { parentAgentId: agentId, childAgentId: childA, boundName: "helper" });
      const dupSub = await mcpError(
        callTool("attach_subagent", { parentAgentId: agentId, childAgentId: childB, boundName: "helper" }),
      );
      expect(dupSub.httpStatus).toBe(409);

      // src/import/create.ts branches on this exact error from attachSecret
      // (and from createDatastore / attachDatastore, covered above).
      for (const secretName of [id("secret-a"), id("secret-b")]) {
        await db.secret.create({ data: { name: secretName, ciphertext: "x", keyId: "k", ownerId: principalId } });
      }
      await attachSecret(agentId, id("secret-a"), principalId, db, "token");
      const err = await knownError(attachSecret(agentId, id("secret-b"), principalId, db, "token"));
      expect(err.code).toBe("P2002");
    });

    it("P2003 (foreign key): delete_agent with run history and delete_datastore with attachments or entries map it to 409", async () => {
      const agentId = await createAgent("p2003-agent");
      await db.run.create({ data: { agentId } });
      expect((await mcpError(callTool("delete_agent", { id: agentId }))).httpStatus).toBe(409);
      expect(await db.agent.count({ where: { id: agentId } })).toBe(1);
      const direct = await knownError(db.agent.delete({ where: { id: agentId } }));
      expect(direct.code).toBe("P2003");

      const attached = await db.datastore.create({ data: { name: id("ds-attached"), ownerId: principalId } });
      await db.agentDatastore.create({ data: { agentId, datastoreId: attached.id, boundName: "kb" } });
      expect((await mcpError(callTool("delete_datastore", { id: attached.id }))).httpStatus).toBe(409);

      const withEntries = await db.datastore.create({ data: { name: id("ds-entries"), ownerId: principalId } });
      await db.datastoreEntry.create({ data: { datastoreId: withEntries.id, key: "k", value: 1 } });
      expect((await mcpError(callTool("delete_datastore", { id: withEntries.id }))).httpStatus).toBe(409);
      expect(await db.datastore.count({ where: { id: { in: [attached.id, withEntries.id] } } })).toBe(2);
    });

    it("P2010 (raw query failure) keeps its code", async () => {
      const err = await knownError(db.$queryRawUnsafe(`SELECT 1 FROM "${PREFIX}no_such_table"`));
      expect(err.code).toBe("P2010");
    });

    it("P2014 (required relation violation) keeps its code", async () => {
      const agentId = await createAgent("p2014-agent");
      const profile = { repository: "openai/example", allowedEgress: [], protectedPaths: [] };
      await db.agent.update({ where: { id: agentId }, data: { codingProfile: { create: profile } } });
      const err = await knownError(
        db.agent.update({ where: { id: agentId }, data: { codingProfile: { create: profile } } }),
      );
      expect(err.code).toBe("P2014");
    });
  });

  describe("MCP tools' Serializable transactions under a genuine conflict", () => {
    // None of these tools retry: a serialization failure propagates to the
    // caller as P2034, and the concurrent writer's commit stands.
    it("set_schedule surfaces P2034", async () => {
      const agentId = await createAgent("set-schedule");
      const conflicted = interleavedDb(() =>
        db.agent.update({ where: { id: agentId }, data: { timezone: "Europe/Paris" } }),
      );
      const err = await knownError(
        callTool("set_schedule", { agentId, schedule: "0 * * * *", timezone: "UTC" }, conflicted),
      );
      expect(err.code).toBe("P2034");
      expect(isSerializationConflict(err)).toBe(true);
      const row = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
      expect(row.timezone).toBe("Europe/Paris");
      expect(row.schedule).toBeNull();
    });

    it("update_agent surfaces P2034", async () => {
      const agentId = await createAgent("update-agent");
      const conflicted = interleavedDb(() =>
        db.agent.update({ where: { id: agentId }, data: { systemPrompt: "concurrent" } }),
      );
      const err = await knownError(callTool("update_agent", { id: agentId, systemPrompt: "mine" }, conflicted));
      expect(err.code).toBe("P2034");
      expect((await db.agent.findUniqueOrThrow({ where: { id: agentId } })).systemPrompt).toBe("concurrent");
    });

    it("attach_tool surfaces P2034 when the same attachment is written concurrently", async () => {
      const agentId = await createAgent("attach-tool");
      const tool = await db.tool.create({
        data: {
          id: id("tool"),
          name: id("tool"),
          description: "t",
          paramsZod: "z.object({})",
          jsonSchema: {},
          code: "return 1;",
          ownerId: principalId,
        },
      });
      const conflicted = interleavedDb(() =>
        db.agentTool.create({ data: { agentId, toolId: tool.id, allowedHosts: ["concurrent.example"] } }),
      );
      const err = await knownError(
        callTool("attach_tool", { agentId, toolId: tool.id, allowedHosts: ["mine.example"] }, conflicted),
      );
      expect(err.code).toBe("P2034");
      const row = await db.agentTool.findUniqueOrThrow({ where: { agentId_toolId: { agentId, toolId: tool.id } } });
      expect(row.allowedHosts).toEqual(["concurrent.example"]);
    });
  });
});
