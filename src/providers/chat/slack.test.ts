import { describe, expect, it, vi } from "vitest";
import { SlackChatProvider } from "./slack.js";
import { ChatError } from "./types.js";

const config = { botToken: "xoxb-t", apiBaseUrl: "https://slack.test/api", customize: false };
const reply = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

describe("SlackChatProvider", () => {
  it("posts with bearer auth, thread_ts and reply_broadcast", async () => {
    const fetchImpl = vi.fn(async () => reply({ ok: true, ts: "1.2" }));
    const slack = new SlackChatProvider(config, fetchImpl);
    await expect(slack.postMessage("C1", { text: "hi" }, { threadTs: "0.1", broadcast: true })).resolves.toEqual({
      ts: "1.2",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://slack.test/api/chat.postMessage");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer xoxb-t");
    expect(JSON.parse(init.body as string)).toEqual({
      channel: "C1",
      text: "hi",
      thread_ts: "0.1",
      reply_broadcast: true,
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("drops username/icon unless customize is on", async () => {
    const fetchImpl = vi.fn(async () => reply({ ok: true, ts: "1" }));
    await new SlackChatProvider(config, fetchImpl).postMessage("C1", {
      text: "x",
      username: "coder",
      iconEmoji: ":robot_face:",
    });
    expect(
      JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string),
    ).not.toHaveProperty("username");
    const f2 = vi.fn(async () => reply({ ok: true, ts: "1" }));
    await new SlackChatProvider({ ...config, customize: true }, f2).postMessage("C1", {
      text: "x",
      username: "coder",
      iconEmoji: ":robot_face:",
    });
    expect(JSON.parse((f2.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({
      username: "coder",
      icon_emoji: ":robot_face:",
    });
  });

  it.each([
    ["channel_not_found", "channel_unreachable"],
    ["not_in_channel", "channel_unreachable"],
    ["is_archived", "channel_unreachable"],
    ["invalid_auth", "auth_failed"],
    ["token_revoked", "auth_failed"],
    ["missing_scope", "auth_failed"],
    ["message_not_found", "message_not_found"],
    ["something_new", "transient"],
  ])("maps %s to %s", async (slackError, code) => {
    const slack = new SlackChatProvider(
      config,
      vi.fn(async () => reply({ ok: false, error: slackError })),
    );
    await expect(slack.postMessage("C1", { text: "x" })).rejects.toMatchObject({ code, slackError });
  });

  it("maps HTTP 429 with Retry-After to rate_limited", async () => {
    const slack = new SlackChatProvider(
      config,
      vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": "7" } })),
    );
    const err = await slack.postMessage("C1", { text: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatError);
    expect(err).toMatchObject({ code: "rate_limited", retryAfterMs: 7000 });
  });

  it("maps a network failure and HTTP 5xx to transient", async () => {
    const down = new SlackChatProvider(
      config,
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(down.postMessage("C1", { text: "x" })).rejects.toMatchObject({ code: "transient" });
    const five = new SlackChatProvider(
      config,
      vi.fn(async () => new Response("", { status: 503 })),
    );
    await expect(five.postMessage("C1", { text: "x" })).rejects.toMatchObject({ code: "transient" });
  });

  it("channelInfo returns null for an unseen channel and resolves #names via conversations.info by id only", async () => {
    const slack = new SlackChatProvider(
      config,
      vi.fn(async () => reply({ ok: false, error: "channel_not_found" })),
    );
    await expect(slack.channelInfo("C404")).resolves.toBeNull();
    const ok = new SlackChatProvider(
      config,
      vi.fn(async () => reply({ ok: true, channel: { id: "C1", name: "eng", is_private: false } })),
    );
    await expect(ok.channelInfo("C1")).resolves.toEqual({ id: "C1", name: "eng", isPrivate: false });
  });

  it("sends conversations.info form-encoded: Slack rejects JSON bodies on read methods", async () => {
    const fetchImpl = vi.fn(async () => reply({ ok: true, channel: { id: "C1", name: "eng" } }));
    await new SlackChatProvider(config, fetchImpl).channelInfo("C1");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://slack.test/api/conversations.info");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(init.body as string).toBe("channel=C1");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer xoxb-t");
  });

  it("keeps JSON bodies for write methods", async () => {
    const fetchImpl = vi.fn(async () => reply({ ok: true, ts: "1" }));
    await new SlackChatProvider(config, fetchImpl).updateMessage("C1", "1.0", { text: "x" });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(init.body as string)).toEqual({ channel: "C1", ts: "1.0", text: "x" });
  });

  it("authTest returns team and bot user", async () => {
    const slack = new SlackChatProvider(
      config,
      vi.fn(async () => reply({ ok: true, team: "Acme", user_id: "U1" })),
    );
    await expect(slack.authTest()).resolves.toEqual({ team: "Acme", botUserId: "U1" });
  });
});
