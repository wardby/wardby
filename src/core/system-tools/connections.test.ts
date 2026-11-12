import { describe, expect, it } from "vitest";
import { ChatError, type ChatProvider } from "../../providers/chat/types.js";
import { redactExactSecretValues } from "../secret-spans.js";
import { buildSlackConnection, channelAllowed, parseChannelScope } from "./connections.js";

const SECRET = "fake-slack-hook-secret-9191";

function fakeChat(fail?: Error) {
  const posted: { channel: string; text: string; threadTs?: string }[] = [];
  const chat = {
    name: "slack",
    async postMessage(channel: string, msg: { text: string }, opts: { threadTs?: string } = {}) {
      if (fail) throw fail;
      posted.push({ channel, text: msg.text, ...(opts.threadTs ? { threadTs: opts.threadTs } : {}) });
      return { ts: "1700000000.000100" };
    },
  } as unknown as ChatProvider;
  return { chat, posted };
}

function captureLogger() {
  const lines: unknown[] = [];
  const logger = {
    child: () => logger,
    info: (...a: unknown[]) => lines.push(a),
    warn: (...a: unknown[]) => lines.push(a),
  };
  return { logger: logger as never, lines };
}

const linkedDb = (linked: string[]) => ({
  notificationChannel: {
    count: async ({ where }: { where: { channelId: string } }) => (linked.includes(where.channelId) ? 1 : 0),
  },
});

describe("parseChannelScope", () => {
  it("upper-cases and de-duplicates channel ids", () => {
    expect(parseChannelScope(["c0abc", "C0ABC", "G0XYZ"])).toEqual({ ok: true, channels: ["C0ABC", "G0XYZ"] });
  });
  it.each([[["linked"]], [["*"]]])("accepts %j", (channels) => {
    expect(parseChannelScope(channels)).toEqual({ ok: true, channels });
  });
  it.each([[[]], [["*", "C0ABC"]], [["linked", "*"]], [["#general"]], ["C0ABC"], [[1]]])("refuses %j", (channels) => {
    expect(parseChannelScope(channels).ok).toBe(false);
  });
});

describe("channelAllowed", () => {
  const isLinked = async (c: string) => c === "C0LINK";
  it("checks a list", async () => {
    expect(await channelAllowed(["C0ABC"], "C0ABC", isLinked)).toBe(true);
    expect(await channelAllowed(["C0ABC"], "C0OTHER", isLinked)).toBe(false);
  });
  it("checks linked channels", async () => {
    expect(await channelAllowed(["linked"], "C0LINK", isLinked)).toBe(true);
    expect(await channelAllowed(["linked"], "C0ABC", isLinked)).toBe(false);
  });
  it("allows any channel with *", async () => {
    expect(await channelAllowed(["*"], "C0ANY", isLinked)).toBe(true);
  });
});

describe("buildSlackConnection", () => {
  const mask = (t: string) => redactExactSecretValues(t, [SECRET]);
  const ids = { toolId: "tool1", hookId: "hook1" };

  it("masks the text before it reaches Slack and logs no text", async () => {
    const { chat, posted } = fakeChat();
    const { logger, lines } = captureLogger();
    const slack = buildSlackConnection({ chat, scope: ["C0ABC"], db: linkedDb([]) as never, mask, ids, logger });
    expect(await slack.post("C0ABC", `report: ${SECRET}`, "1700000000.000001")).toEqual({ ts: "1700000000.000100" });
    expect(posted).toHaveLength(1);
    expect(posted[0].text).not.toContain(SECRET);
    expect(posted[0].threadTs).toBe("1700000000.000001");
    expect(JSON.stringify(lines)).not.toContain("report");
  });

  it("refuses a channel outside the scope", async () => {
    const { chat, posted } = fakeChat();
    const slack = buildSlackConnection({ chat, scope: ["linked"], db: linkedDb(["C0LINK"]) as never, mask, ids });
    await expect(slack.post("C0ABC", "x")).rejects.toThrow("slack_channel_not_granted: C0ABC");
    await slack.post("C0LINK", "x");
    expect(posted.map((p) => p.channel)).toEqual(["C0LINK"]);
  });

  it("returns Slack's error code only", async () => {
    const { chat } = fakeChat(new ChatError("auth_failed", "missing_scope"));
    const slack = buildSlackConnection({ chat, scope: ["*"], db: linkedDb([]) as never, mask, ids });
    await expect(slack.post("C0ABC", SECRET)).rejects.toThrow(/^slack_error: auth_failed:missing_scope$/);
  });

  it("hides a non-Slack error's message", async () => {
    const { chat } = fakeChat(new Error(`socket closed ${SECRET}`));
    const slack = buildSlackConnection({ chat, scope: ["*"], db: linkedDb([]) as never, mask, ids });
    await expect(slack.post("C0ABC", "x")).rejects.toThrow(/^slack_error: transient:request_failed$/);
  });
});
