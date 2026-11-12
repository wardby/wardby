/**
 * A run hook on a public tool an admin granted Slack (#529), against real
 * PostgreSQL and the real sandbox: slack.post reaches the server's chat
 * provider with the text masked by exact value; an owned tool, or a public
 * tool without a grant, gets connection_unavailable; a channel outside the
 * grant is refused; ["linked"] follows notification links. Skipped without
 * DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatProvider } from "../../providers/chat/types.js";
import type { Datastore } from "../../providers/datastore/types.js";
import { createPrismaClient } from "../db.js";
import { attachSecret, createSecret } from "../secrets.js";
import { callRunHook, HOOK_TOOL_SELECT } from "./dispatcher.js";
import { SAMPLE_PAYLOADS } from "./samples.js";

const SECRET = "fake-system-slack-secret-5150";

describe.skipIf(!process.env.DATABASE_URL)("run hook with the server's Slack connection (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (v: string) => v, decrypt: async (v: string) => v };
  const datastore = {
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined,
    list: async () => [],
  } as unknown as Datastore;
  const s = randomUUID();
  const id = (name: string) => `sysslack-${name}-${s}`;
  const owner = id("owner");
  const agent = id("agent");
  const linkedChannel = `C0L${s.slice(0, 8).replace(/-/g, "").toUpperCase()}`;
  const posted: { channel: string; text: string; threadTs?: string }[] = [];
  const chat = {
    name: "slack",
    async postMessage(channel: string, msg: { text: string }, opts: { threadTs?: string } = {}) {
      posted.push({ channel, text: msg.text, ...(opts.threadTs ? { threadTs: opts.threadTs } : {}) });
      return { ts: `1700000000.00000${posted.length}` };
    },
  } as unknown as ChatProvider;
  const rt = { db, secrets: cipher, datastore, chat: { slack: chat } };
  const ZOD =
    "z.object({ event: z.object({ kind: z.string() }).passthrough(), config: z.object({ channel: z.string() }) })";
  const CODE = `const { ts } = await slack.post(params.config.channel, params.event.kind + " ${SECRET}");
await slack.post(params.config.channel, "more", { threadTs: ts });
return ts;`;

  async function tool(name: string, ownerId: string | null, channels?: string[]) {
    await db.tool.create({
      data: { id: id(name), name: id(name), description: "t", paramsZod: ZOD, jsonSchema: {}, code: CODE, ownerId },
    });
    if (channels) await db.toolConnectionGrant.create({ data: { toolId: id(name), connection: "slack", channels } });
    return db.tool.findUniqueOrThrow({ where: { id: id(name) }, select: HOOK_TOOL_SELECT });
  }

  const deliver = async (toolRow: Awaited<ReturnType<typeof tool>>, channel: string) =>
    callRunHook(rt, {
      hook: {
        id: id("hook"),
        enabled: true,
        includeFinalText: false,
        config: { channel },
        allowedSecrets: [],
        allowedHosts: [],
        capabilitiesGrantedById: null,
      },
      tool: toolRow,
      agent: { id: agent, name: agent, ownerId: owner },
      event: {
        id: id("event"),
        kind: "run_completed",
        runId: null,
        createdAt: new Date(),
        payload: SAMPLE_PAYLOADS.run_completed,
      },
    });

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.agent.create({
      data: { id: agent, name: agent, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner },
    });
    await createSecret(`SYS_KEY_${s.slice(0, 8)}`, SECRET, owner, cipher, db);
    await attachSecret(agent, `SYS_KEY_${s.slice(0, 8)}`, owner, db);
    await db.notificationChannel.create({
      data: { provider: "slack", channelId: linkedChannel, agentId: agent, authorizedById: owner },
    });
  });

  afterAll(async () => {
    await db.notificationChannel.deleteMany({ where: { agentId: agent } });
    await db.tool.deleteMany({ where: { id: { startsWith: `sysslack-` }, name: { endsWith: s } } });
    await db.agentSecret.deleteMany({ where: { agentId: agent } });
    await db.secret.deleteMany({ where: { ownerId: owner } });
    await db.agent.deleteMany({ where: { id: agent } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("posts through the server's Slack client, masked, in a thread", async () => {
    posted.length = 0;
    const row = await tool("listed", null, ["C0ABC"]);
    expect(await deliver(row, "C0ABC")).toEqual({ ok: true });
    expect(posted).toHaveLength(2);
    expect(posted[0].channel).toBe("C0ABC");
    expect(posted[0].text).toContain("run_completed");
    expect(posted[0].text).not.toContain(SECRET);
    expect(posted[1].threadTs).toBe("1700000000.000001");
  });

  it("refuses a channel outside the grant", async () => {
    posted.length = 0;
    const row = await tool("narrow", null, ["C0ABC"]);
    const result = await deliver(row, "C0OTHER");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("slack_channel_not_granted");
    expect(posted).toHaveLength(0);
  });

  it("follows notification links for linked", async () => {
    posted.length = 0;
    const row = await tool("linked", null, ["linked"]);
    expect(await deliver(row, linkedChannel)).toEqual({ ok: true });
    expect((await deliver(row, "C0NOTLINKED")).ok).toBe(false);
  });

  it("gives an owned tool, or an ungranted public tool, no connection", async () => {
    posted.length = 0;
    for (const row of [await tool("owned", owner, ["*"]), await tool("ungranted", null)]) {
      const result = await deliver(row, "C0ABC");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("connection_unavailable");
    }
    expect(posted).toHaveLength(0);
  });
});
