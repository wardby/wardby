import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import type { McpRequestContext } from "../context.js";
import { registerModelCatalogTools, raceLostError } from "./model-catalog.js";
import { RoutingLlmProvider } from "../../providers/llm/routing.js";
import type { CatalogLlmAdapter } from "../../providers/llm/routing.js";
import { CatalogStore, installModelCatalog, uninstallModelCatalogForTests } from "../../providers/llm/catalog-store.js";

const logged = vi.hoisted(() => [] as { level: string; payload: Record<string, unknown>; message: string }[]);
vi.mock("../../core/logger.js", () => {
  const make = (): Record<string, unknown> => {
    const at =
      (level: string) =>
      (payload: Record<string, unknown>, message?: string): void => {
        logged.push({ level, payload, message: message ?? "" });
      };
    return {
      child: () => make(),
      trace: at("trace"),
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
      fatal: at("fatal"),
    };
  };
  return { logger: make() };
});

const CANONICAL_URI = "https://host/mcp";
const READER = { scopes: ["agents:read"], roles: [] as string[] };
const MODEL_MANAGER = { scopes: ["agents:read", "models:admin"], roles: ["model-manager"] };
/** Holds the scope on its token but no role granting it: scopes only delegate. */
const UNROLED = { scopes: ["agents:read", "models:admin"], roles: [] as string[] };

const NEW = {
  provider: "anthropic",
  modelId: "claude-new",
  encoding: "o200k_base",
  inputPerMTok: 3,
  outputPerMTok: 15,
  cachedInputPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
  efforts: ["low", "high"],
  thinkingMode: "adaptive",
  sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
};

function fakeLlm(name: string): CatalogLlmAdapter {
  const self: CatalogLlmAdapter = {
    async *stream() {
      yield { type: "done", stopReason: "stop", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
    },
    async countTokens() {
      return name.length;
    },
    priceUsd() {
      return 0;
    },
    withEntry: () => self,
  };
  return self;
}

/** An in-memory ModelCatalogEntry table backing a real CatalogStore, so set/disable/reset
 *  are exercised against the same merge logic the real deployment runs on. */
function fakeDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const keyOf = (where: { provider_modelId: { provider: string; modelId: string } }) =>
    `${where.provider_modelId.provider}::${where.provider_modelId.modelId}`;
  const modelCatalogEntry = {
    findMany: async (args?: { where?: { modelId?: string } }) => {
      const all = [...rows.values()];
      if (args?.where?.modelId !== undefined) return all.filter((row) => row.modelId === args.where!.modelId);
      return all;
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { provider_modelId: { provider: string; modelId: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const key = keyOf(where);
      const now = new Date();
      const existing = rows.get(key);
      const row = existing ? { ...existing, ...update, updatedAt: now } : { ...create, createdAt: now, updatedAt: now };
      rows.set(key, row);
      return row;
    },
    deleteMany: async ({ where }: { where: { modelId: string } }) => {
      let count = 0;
      for (const [key, row] of rows) {
        if (row.modelId === where.modelId) {
          rows.delete(key);
          count++;
        }
      }
      return { count };
    },
  };
  return { db: { modelCatalogEntry } as unknown as import("#prisma").PrismaClient, rows };
}

const quietLog = { warn: () => undefined, info: () => undefined };
let activeStore: CatalogStore | undefined;

afterEach(() => {
  activeStore?.close();
  activeStore = undefined;
  uninstallModelCatalogForTests();
});

async function connect(who: { scopes: string[]; roles: string[] }, overrides: { refresh?: () => Promise<void> } = {}) {
  const { db, rows } = fakeDb();
  const llm = new RoutingLlmProvider([{ provider: "anthropic", adapter: fakeLlm("anthropic") }]);
  const providers = { llm } as unknown as McpRequestContext["providers"];
  const store = new CatalogStore(db, { log: quietLog });
  await store.start();
  installModelCatalog(store);
  activeStore = store;

  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL_URI } });
  mcp.setFixedContext({
    principal: { id: "p-admin", subject: "p-admin", createdAt: new Date() },
    scopes: new Set(who.scopes),
    roles: who.roles,
    canonicalUri: CANONICAL_URI,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  });
  registerModelCatalogTools(mcp, { refresh: overrides.refresh ?? (() => store.refreshNow()) });
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, rows, store };
}

const text = (result: { content: unknown }) => (result.content as { text: string }[])[0].text;

/** A raw ModelCatalogEntry record, as `rows.set(...)` plants directly into the fake DB
 *  (bypassing set_model/disable_model entirely) to simulate a row this process's own
 *  write path would never produce on its own — an orphan from another provider, or one
 *  malformed enough that rowFromRecord rejects it. */
function rawRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    provider: "openai",
    modelId: "claude-sonnet-5",
    enabled: true,
    encoding: "o200k_base",
    inputPerMTok: 1,
    outputPerMTok: 5,
    cachedInputPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    efforts: [],
    thinkingMode: "none",
    sourceUrl: "https://platform.openai.com/docs/pricing",
    updatedBy: "p-other",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("model catalog tools", () => {
  it("lists shipped models with origin, price version and routability", async () => {
    const { client } = await connect(READER);
    const out = JSON.parse(text(await client.callTool({ name: "list_models", arguments: {} })));
    expect(out.models).toContainEqual(
      expect.objectContaining({
        modelId: "claude-haiku-4-5",
        origin: "shipped",
        priceVersion: "shipped:2026-11-25",
        routable: true,
        thinkingMode: "manual",
      }),
    );
    expect(out.models).toContainEqual(expect.objectContaining({ modelId: "gpt-4o", routable: false }));
    await client.close();
  });

  it.each([
    ["set_model", NEW],
    ["disable_model", { modelId: "claude-sonnet-5" }],
    ["reset_model", { modelId: "claude-sonnet-5" }],
  ])("%s needs models:admin: readers are refused", async (name, args) => {
    const { client } = await connect(READER);
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Insufficient scope; this operation requires: models:admin/);
    await client.close();
  });

  it.each([
    ["set_model", NEW],
    ["disable_model", { modelId: "claude-sonnet-5" }],
  ])("%s needs a role granting models:admin, not just the scope", async (name, args) => {
    const { client } = await connect(UNROLED);
    const r = await client.callTool({ name, arguments: args });
    expect(text(r)).toMatch(/requires a role that grants it/);
    await client.close();
  });

  it("set_model adds a routable model immediately and audits it", async () => {
    logged.length = 0;
    const { client } = await connect(MODEL_MANAGER);
    const r = await client.callTool({ name: "set_model", arguments: NEW });
    expect(r.isError).toBeFalsy();
    const listed = JSON.parse(text(await client.callTool({ name: "list_models", arguments: {} })));
    expect(listed.models).toContainEqual(
      expect.objectContaining({ modelId: "claude-new", origin: "override", routable: true }),
    );
    expect(logged).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ event: "models.catalog.set", modelId: "claude-new", by: "p-admin" }),
      }),
    );
    await client.close();
  });

  it.each(["cachedInputPerMTok", "cacheWritePerMTok", "sourceUrl", "thinkingMode", "efforts"])(
    "set_model refuses an entry missing %s",
    async (field) => {
      const { client } = await connect(MODEL_MANAGER);
      const { [field]: _omit, ...partial } = NEW as Record<string, unknown>;
      const r = await client.callTool({ name: "set_model", arguments: partial });
      expect(r.isError).toBe(true);
      await client.close();
    },
  );

  it.each([
    ["an unknown provider", { provider: "azure" }],
    ["an unknown thinking mode", { thinkingMode: "sometimes" }],
    ["an unknown effort", { efforts: ["turbo"] }],
    ["a negative rate", { outputPerMTok: -1 }],
    ["a non-https source", { sourceUrl: "http://example.com" }],
  ])("set_model refuses %s", async (_label, over) => {
    const { client } = await connect(MODEL_MANAGER);
    expect((await client.callTool({ name: "set_model", arguments: { ...NEW, ...over } })).isError).toBe(true);
    await client.close();
  });

  it("set_model refuses another provider for a shipped id, and says it can never be reassigned", async () => {
    const { client } = await connect(MODEL_MANAGER);
    const r = await client.callTool({
      name: "set_model",
      arguments: { ...NEW, provider: "openai", modelId: "claude-sonnet-5", thinkingMode: "none", efforts: [] },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/shipped model.*belongs to provider "anthropic"/);
    expect(text(r)).toMatch(/can never be served by another provider/);
    await client.close();
  });

  it("disabling a shipped model's override still refuses another provider, with the same never-reassignable message", async () => {
    const { client } = await connect(MODEL_MANAGER);
    // Disabling claude-sonnet-5 keeps a disabled row under its original provider
    // (anthropic); a shipped id belongs to its shipped provider no matter what
    // its override row says, so this must refuse exactly like the active case —
    // reset_model would not change that either, since the id is shipped.
    await client.callTool({ name: "disable_model", arguments: { modelId: "claude-sonnet-5" } });
    const r = await client.callTool({
      name: "set_model",
      arguments: { ...NEW, provider: "openai", modelId: "claude-sonnet-5", thinkingMode: "none", efforts: [] },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/shipped model.*belongs to provider "anthropic"/);
    expect(text(r)).toMatch(/can never be served by another provider/);
    await client.close();
  });

  it("set_model refuses another provider for a non-shipped id already claimed, enabled or disabled, until reset_model", async () => {
    const { client } = await connect(MODEL_MANAGER);
    await client.callTool({ name: "set_model", arguments: NEW }); // claude-new, anthropic
    const whileEnabled = await client.callTool({
      name: "set_model",
      arguments: { ...NEW, provider: "openai" },
    });
    expect(whileEnabled.isError).toBe(true);
    expect(text(whileEnabled)).toMatch(/already served by provider "anthropic"/);
    expect(text(whileEnabled)).toMatch(/reset_model it first/);

    // disable_model does not free the id for another provider: the row (and
    // its provider claim) stays, only `enabled` flips.
    await client.callTool({ name: "disable_model", arguments: { modelId: "claude-new" } });
    const whileDisabled = await client.callTool({
      name: "set_model",
      arguments: { ...NEW, provider: "openai" },
    });
    expect(whileDisabled.isError).toBe(true);
    expect(text(whileDisabled)).toMatch(/reserved by a disabled entry for provider "anthropic"/);
    expect(text(whileDisabled)).toMatch(/reset_model it first/);

    // reset_model does free it: a non-shipped id has no shipped owner to fall back to.
    await client.callTool({ name: "reset_model", arguments: { modelId: "claude-new" } });
    const afterReset = await client.callTool({
      name: "set_model",
      arguments: { ...NEW, provider: "openai" },
    });
    expect(afterReset.isError).toBeFalsy();
    await client.close();
  });

  it("set_model refuses a conflicting row that exists in the database but hasn't reached the installed catalog yet", async () => {
    const { client, rows } = await connect(MODEL_MANAGER);
    // Simulate another process/replica's write landing after this process's
    // last poll: present in the database, invisible to the installed
    // (in-memory, poll-interval-stale) catalog, since we never refresh here.
    rows.set("openai::claude-new", rawRow({ modelId: "claude-new" }));
    const r = await client.callTool({ name: "set_model", arguments: NEW });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/already served by provider "openai"/);
    await client.close();
  });

  it("set_model refuses an orphaned other-provider row's own provider for a shipped id (the shipped provider always owns it)", async () => {
    const { client, rows } = await connect(MODEL_MANAGER);
    // buildCatalog seeds ownership of a shipped id from the shipped provider
    // BEFORE considering any row, so a row under any other provider is a
    // permanently dead orphan — this must still refuse that same orphan
    // provider trying to write/update its own dead row.
    rows.set("openai::claude-sonnet-5", rawRow());
    const r = await client.callTool({
      name: "set_model",
      arguments: { ...NEW, provider: "openai", modelId: "claude-sonnet-5", thinkingMode: "none", efforts: [] },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/shipped model.*belongs to provider "anthropic"/);
    // Nothing was written: the orphan row is untouched.
    expect(rows.get("openai::claude-sonnet-5")).toMatchObject({ outputPerMTok: 5 });
    await client.close();
  });

  it("set_model under the shipped provider still succeeds despite an orphaned other-provider row for the same id", async () => {
    const { client, rows } = await connect(MODEL_MANAGER);
    rows.set("openai::claude-sonnet-5", rawRow());
    const r = await client.callTool({
      name: "set_model",
      arguments: { ...NEW, modelId: "claude-sonnet-5", outputPerMTok: 11 },
    });
    expect(r.isError).toBeFalsy();
    expect(rows.get("anthropic::claude-sonnet-5")).toMatchObject({ outputPerMTok: 11 });
    // The orphan is left alone — cleaning it up is reset_model's job, not set_model's.
    expect(rows.has("openai::claude-sonnet-5")).toBe(true);
    await client.close();
  });

  it("owner edits its row, a later orphan does not take over: repricing keeps the id with the provider that claimed it first", async () => {
    const { client, rows } = await connect(MODEL_MANAGER);
    expect((await client.callTool({ name: "set_model", arguments: NEW })).isError).toBeFalsy(); // claude-new, anthropic
    // Backdate the owner's claim, then plant another provider's orphan row
    // claimed (created) after it but before the owner's next edit.
    const claimedAt = new Date("2026-01-01T00:00:00.000Z");
    const owner = rows.get("anthropic::claude-new")!;
    rows.set("anthropic::claude-new", { ...owner, createdAt: claimedAt, updatedAt: claimedAt });
    const orphanAt = new Date("2026-02-01T00:00:00.000Z");
    rows.set("openai::claude-new", rawRow({ modelId: "claude-new", createdAt: orphanAt, updatedAt: orphanAt }));

    // The owner reprices: its updatedAt moves past the orphan's, its createdAt does not.
    const repriced = await client.callTool({ name: "set_model", arguments: { ...NEW, outputPerMTok: 16 } });
    expect(repriced.isError).toBeFalsy();
    const got = JSON.parse(text(await client.callTool({ name: "get_model", arguments: { modelId: "claude-new" } })));
    expect(got.model).toMatchObject({ provider: "anthropic", outputPerMTok: 16 });

    // And the orphan's provider is still refused.
    const orphanWrite = await client.callTool({
      name: "set_model",
      arguments: { ...NEW, provider: "openai", thinkingMode: "none", efforts: [] },
    });
    expect(orphanWrite.isError).toBe(true);
    expect(text(orphanWrite)).toMatch(/already served by provider "anthropic"/);
    await client.close();
  });

  it("the post-write ownership-race error names reset_model and the true owner, not a blind retry", () => {
    const err = raceLostError("claude-new", "anthropic", "openai");
    expect(err.message).toMatch(/written for provider "anthropic"/);
    expect(err.message).toMatch(/provider "openai" owns it/);
    expect(err.message).toMatch(/reset_model removes every row/);
    expect(err.message).not.toMatch(/retry set_model/i);
  });

  it("set_model still succeeds and audits the change when the post-write catalog refresh fails", async () => {
    logged.length = 0;
    const { client, rows } = await connect(MODEL_MANAGER, {
      refresh: () => Promise.reject(new Error("db unreachable")),
    });
    const r = await client.callTool({ name: "set_model", arguments: NEW });
    expect(r.isError).toBeFalsy();
    // The write landed even though the refresh that followed it failed.
    expect(rows.has("anthropic::claude-new")).toBe(true);
    expect(logged).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          event: "models.catalog.set",
          modelId: "claude-new",
          by: "p-admin",
          before: null,
          after: expect.objectContaining({ provider: "anthropic", modelId: "claude-new", outputPerMTok: 15 }),
        }),
      }),
    );
    await client.close();
  });

  it("set_model warns on a zero rate", async () => {
    const { client } = await connect(MODEL_MANAGER);
    const out = JSON.parse(
      text(await client.callTool({ name: "set_model", arguments: { ...NEW, cachedInputPerMTok: 0 } })),
    );
    expect(out.warnings).toEqual([expect.stringMatching(/cachedInputPerMTok is 0/)]);
    await client.close();
  });

  it("overriding a shipped model shows the shipped entry it shadows", async () => {
    const { client } = await connect(MODEL_MANAGER);
    const sonnet = {
      ...NEW,
      modelId: "claude-sonnet-5",
      outputPerMTok: 11,
      efforts: ["low", "medium", "high", "xhigh", "max"],
    };
    await client.callTool({ name: "set_model", arguments: sonnet });
    const got = JSON.parse(
      text(await client.callTool({ name: "get_model", arguments: { modelId: "claude-sonnet-5" } })),
    );
    expect(got.model).toMatchObject({ origin: "override", outputPerMTok: 11, shippedDiffers: true });
    expect(got.shipped).toMatchObject({ outputPerMTok: 10 });
    await client.close();
  });

  it("disable_model removes a shipped model; reset_model brings it back", async () => {
    const { client } = await connect(MODEL_MANAGER);
    await client.callTool({ name: "disable_model", arguments: { modelId: "claude-sonnet-5" } });
    let listed = JSON.parse(text(await client.callTool({ name: "list_models", arguments: { includeDisabled: true } })));
    expect(listed.models.map((m: { modelId: string }) => m.modelId)).not.toContain("claude-sonnet-5");
    expect(listed.disabled.map((m: { modelId: string }) => m.modelId)).toContain("claude-sonnet-5");
    await client.callTool({ name: "reset_model", arguments: { modelId: "claude-sonnet-5" } });
    listed = JSON.parse(text(await client.callTool({ name: "list_models", arguments: {} })));
    expect(listed.models).toContainEqual(expect.objectContaining({ modelId: "claude-sonnet-5", origin: "shipped" }));
    await client.close();
  });

  it("reset_model of an added model removes it; of an untouched model is a 404", async () => {
    const { client } = await connect(MODEL_MANAGER);
    await client.callTool({ name: "set_model", arguments: NEW });
    await client.callTool({ name: "reset_model", arguments: { modelId: "claude-new" } });
    const got = await client.callTool({ name: "get_model", arguments: { modelId: "claude-new" } });
    expect(got.isError).toBe(true);
    expect((await client.callTool({ name: "reset_model", arguments: { modelId: "claude-haiku-4-5" } })).isError).toBe(
      true,
    );
    await client.close();
  });

  it("reset_model deletes a model id whose only row is malformed, and still succeeds with its provider audited", async () => {
    logged.length = 0;
    const { client, rows } = await connect(MODEL_MANAGER);
    // thinkingMode isn't one of THINKING_MODES, so rowFromRecord rejects this
    // row — but it's still a real row occupying "broken-model" under openai.
    rows.set(
      "openai::broken-model",
      rawRow({ modelId: "broken-model", thinkingMode: "not-a-real-mode", provider: "openai" }),
    );
    const r = await client.callTool({ name: "reset_model", arguments: { modelId: "broken-model" } });
    expect(r.isError).toBeFalsy();
    expect(rows.has("openai::broken-model")).toBe(false);
    expect(logged).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          event: "models.catalog.reset",
          modelId: "broken-model",
          provider: "openai",
        }),
      }),
    );
    await client.close();
  });
});
