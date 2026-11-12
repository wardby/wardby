import { describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { PrismaClient } from "#prisma";
import { buildMcpServer } from "../server.js";
import type { McpRequestContext } from "../context.js";
import { DISABLED_POWER, type Power } from "../../core/power.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { registerPowerTools } from "./power.js";

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
const ADMIN = { scopes: ["agents:read", "power:manage"], roles: ["admin"] };
/** Holds the scope on its token but no role granting it: scopes only delegate. */
const UNROLED = { scopes: ["agents:read", "power:manage"], roles: [] as string[] };
const MODEL_MANAGER = { scopes: ["agents:read", "power:manage"], roles: ["model-manager"] };
const READER = { scopes: ["agents:read"], roles: [] as string[] };

function fakePower(overrides: Partial<Power> = {}): Power {
  return {
    ...DISABLED_POWER,
    enabled: true,
    sleepNow: vi.fn(async (targets) => ({ slept: targets, blocked: [] })),
    status: vi.fn(async () => ({ enabled: true, targets: [] })),
    ...overrides,
  };
}

async function connect(who: { scopes: string[]; roles: string[] }, power: Power | undefined) {
  const providers = { power } as unknown as McpRequestContext["providers"];
  const db = {} as PrismaClient;
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
  registerPowerTools(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

/** The registered handler itself, to see the McpError (and its HTTP status) a client only sees as text. */
function handlerOf(name: string, power: Power | undefined) {
  const handlers = new Map<string, (args: unknown, ctx: McpRequestContext) => Promise<unknown>>();
  registerPowerTools({
    registerTool: (spec: { name: string; handler: (args: unknown, ctx: McpRequestContext) => Promise<unknown> }) =>
      handlers.set(spec.name, spec.handler),
  } as unknown as WardbyMcpServer);
  const ctx = { principal: { id: "p-admin" }, providers: { power } } as unknown as McpRequestContext;
  return (args: unknown) => handlers.get(name)!(args, ctx);
}

const text = (result: { content: unknown }) => (result.content as { text: string }[])[0].text;

describe("power tools", () => {
  it("registers both tools with descriptions naming power:manage", async () => {
    const client = await connect(ADMIN, fakePower());
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("power_sleep")?.description).toMatch(/^Admins \(power:manage\): /);
    expect(byName.get("power_sleep")?.description).toMatch(/never stops a run/i);
    expect(byName.get("power_status")?.description).toMatch(/^Admins \(power:manage\): /);
    await client.close();
  });

  it.each([
    ["power_sleep", {}],
    ["power_status", {}],
  ])("%s needs a role granting power:manage, not just the scope", async (name, args) => {
    for (const who of [UNROLED, MODEL_MANAGER]) {
      const power = fakePower();
      const client = await connect(who, power);
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/requires a role that grants it \(admin\)/);
      expect(power.sleepNow).not.toHaveBeenCalled();
      expect(power.status).not.toHaveBeenCalled();
      await client.close();
    }
  });

  it("power_sleep needs the power:manage scope", async () => {
    const client = await connect(READER, fakePower());
    const r = await client.callTool({ name: "power_sleep", arguments: {} });
    expect(text(r)).toMatch(/Insufficient scope; this operation requires: power:manage/);
    await client.close();
  });

  it("power_sleep with no arguments sleeps both targets, and audits it", async () => {
    logged.length = 0;
    const power = fakePower({
      sleepNow: vi.fn(async () => ({
        slept: ["proxy" as const],
        blocked: [{ target: "gateway" as const, runIds: ["r1"] }],
      })),
    });
    const client = await connect(ADMIN, power);
    const r = await client.callTool({ name: "power_sleep", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(power.sleepNow).toHaveBeenCalledWith(["proxy", "gateway"]);
    expect(JSON.parse(text(r))).toEqual({ slept: ["proxy"], blocked: [{ target: "gateway", runIds: ["r1"] }] });
    expect(logged.find((entry) => entry.payload.event === "power.sleep")?.payload).toEqual({
      event: "power.sleep",
      principal: "p-admin",
      targets: ["proxy", "gateway"],
      outcome: "ok",
      slept: ["proxy"],
      blocked: [{ target: "gateway", runIds: ["r1"] }],
    });
    await client.close();
  });

  it("power_sleep with a target sleeps only that target", async () => {
    const power = fakePower();
    const client = await connect(ADMIN, power);
    const r = await client.callTool({ name: "power_sleep", arguments: { target: "gateway" } });
    expect(JSON.parse(text(r))).toEqual({ slept: ["gateway"], blocked: [] });
    expect(power.sleepNow).toHaveBeenCalledWith(["gateway"]);
    await client.close();
  });

  it("power_sleep accepts the renderer as a target", async () => {
    const power = fakePower();
    const client = await connect(ADMIN, power);
    const r = await client.callTool({ name: "power_sleep", arguments: { target: "renderer" } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toEqual({ slept: ["renderer"], blocked: [] });
    expect(power.sleepNow).toHaveBeenCalledWith(["renderer"]);
    await client.close();
  });

  it.each([[{ target: "control-plane" }], [{ target: "proxy", force: true }], [{ target: 1 }]])(
    "power_sleep rejects %j",
    async (args) => {
      const power = fakePower();
      const client = await connect(ADMIN, power);
      const r = await client.callTool({ name: "power_sleep", arguments: args });
      expect(r.isError).toBe(true);
      expect(power.sleepNow).not.toHaveBeenCalled();
      await client.close();
    },
  );

  it.each([
    ["DISABLED_POWER", DISABLED_POWER],
    ["no power provider", undefined],
  ])("power_sleep fails 409 low_power_disabled with %s", async (_label, power) => {
    const client = await connect(ADMIN, power);
    const r = await client.callTool({ name: "power_sleep", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("low_power_disabled: WARDBY_LOW_POWER is not 1 on this deployment.");
    await client.close();
    const err = await handlerOf("power_sleep", power)({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).httpStatus).toBe(409);
    expect((err as McpError).message).toBe("low_power_disabled: WARDBY_LOW_POWER is not 1 on this deployment.");
  });

  it("power_sleep audits a refused call (mode off) with the principal", async () => {
    logged.length = 0;
    await handlerOf("power_sleep", undefined)({ target: "proxy" }).catch(() => undefined);
    expect(logged.find((entry) => entry.payload.event === "power.sleep")?.payload).toEqual({
      event: "power.sleep",
      principal: "p-admin",
      targets: ["proxy"],
      outcome: "error",
      error: "low_power_disabled: WARDBY_LOW_POWER is not 1 on this deployment.",
    });
  });

  it("power_sleep audits a call that fails after sleeping a target, then rethrows", async () => {
    logged.length = 0;
    // As if the proxy was patched to 0 and the gateway's patch was then forbidden.
    const power = fakePower({
      sleepNow: vi.fn(async () => {
        throw new Error(
          'low_power_scale_forbidden: the control plane may not patch Deployment "wardby-native-gateway"',
        );
      }),
    });
    const client = await connect(ADMIN, power);
    const r = await client.callTool({ name: "power_sleep", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("low_power_scale_forbidden");
    const audit = logged.filter((entry) => entry.payload.event === "power.sleep");
    expect(audit).toHaveLength(1);
    expect(audit[0].level).toBe("warn");
    expect(audit[0].payload).toEqual({
      event: "power.sleep",
      principal: "p-admin",
      targets: ["proxy", "gateway"],
      outcome: "error",
      error: 'low_power_scale_forbidden: the control plane may not patch Deployment "wardby-native-gateway"',
    });
    await client.close();
  });

  it("power_status returns power.status() as the text result", async () => {
    const status = {
      enabled: true,
      targets: [
        { target: "proxy" as const, replicas: 1, ready: true, wokeAt: "2026-10-11T11:00:00.000Z", blockers: ["r1"] },
      ],
    };
    const power = fakePower({ status: vi.fn(async () => status) });
    const client = await connect(ADMIN, power);
    const r = await client.callTool({ name: "power_status", arguments: {} });
    expect(JSON.parse(text(r))).toEqual(status);
    await client.close();
  });

  it("power_status with power disabled reports enabled false", async () => {
    const client = await connect(ADMIN, undefined);
    const r = await client.callTool({ name: "power_status", arguments: {} });
    expect(JSON.parse(text(r))).toEqual({ enabled: false });
    await client.close();
  });
});
