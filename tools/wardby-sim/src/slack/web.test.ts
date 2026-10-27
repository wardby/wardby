import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SlackChatProvider } from "../../../../src/providers/chat/slack.js";
import { ChatError } from "../../../../src/providers/chat/types.js";
import { createSimServer, simRequest, type SimServer } from "../server.js";
import { createSlackService, SIM_SLACK_TOKEN, SLACK_PREFIX, type SlackState } from "./web.js";

let sim: SimServer;
const script = async (steps: Record<string, unknown>[]) => {
  const response = await sim.dispatch(simRequest("POST", "/__sim/script", { steps }));
  const body = JSON.parse(String(response.body)) as { results: any[]; error?: string };
  if (response.status !== 200) throw new Error(body.error);
  return body.results;
};

/** wardby's real Slack client, its requests answered by the simulator. */
function client(token = SIM_SLACK_TOKEN, customize = false): SlackChatProvider {
  const fetchAdapter = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const response = await sim.dispatch(
      simRequest(init?.method ?? "GET", url.pathname, typeof init?.body === "string" ? init.body : "", headers),
    );
    return new Response(response.body ?? null, { status: response.status, headers: response.headers ?? {} });
  }) as typeof fetch;
  return new SlackChatProvider(
    { botToken: token, apiBaseUrl: `https://sim.invalid${SLACK_PREFIX}`, customize },
    fetchAdapter,
  );
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    expect(error).toBeInstanceOf(ChatError);
    return `${(error as ChatError).code}:${(error as ChatError).slackError}`;
  }
}

beforeEach(async () => {
  sim = createSimServer({ services: [createSlackService()] });
  await script([
    { action: "slack.channel", id: "CPUB", name: "builds" },
    { action: "slack.channel", id: "CPRIV", name: "secret-team", private: true },
    { action: "slack.channel", id: "COUT", name: "elsewhere", member: false },
    { action: "slack.channel", id: "CPRIVOUT", name: "hidden", private: true, member: false },
    { action: "slack.channel", id: "CARCH", name: "old", archived: true },
  ]);
});
afterEach(async () => {
  await sim.close();
});

describe("Slack sim through wardby's own Slack client", () => {
  it("auth.test, conversations.info, a post, a thread reply and an update", async () => {
    const slack = client();
    expect(await slack.authTest()).toEqual({ team: "Sim Workspace", botUserId: "USIMBOT01" });
    expect(await slack.channelInfo("CPUB")).toEqual({ id: "CPUB", name: "builds", isPrivate: false });
    expect(await slack.channelInfo("#secret-team")).toEqual({ id: "CPRIV", name: "secret-team", isPrivate: true });
    const { ts } = await slack.postMessage("CPUB", { text: "run started" });
    const reply = await slack.postMessage("CPUB", { text: "PR opened" }, { threadTs: ts, broadcast: true });
    await slack.updateMessage("CPUB", ts, { text: "run finished" });
    const [{ messages }] = await script([{ action: "slack.messages", channel: "CPUB" }]);
    expect(messages).toEqual([
      expect.objectContaining({ ts, text: "run finished", edits: [{ text: "run started" }] }),
      expect.objectContaining({ ts: reply.ts, threadTs: ts, replyBroadcast: true }),
    ]);
    expect(JSON.stringify(sim.state.calls.list())).not.toContain(SIM_SLACK_TOKEN);
  });

  it("maps every error wardby classifies", async () => {
    const slack = client();
    expect(await slack.channelInfo("CPRIVOUT")).toBeNull();
    expect(await slack.channelInfo("CNOPE")).toBeNull();
    expect(await codeOf(slack.postMessage("CNOPE", { text: "x" }))).toBe("channel_unreachable:channel_not_found");
    expect(await codeOf(slack.postMessage("COUT", { text: "x" }))).toBe("channel_unreachable:not_in_channel");
    expect(await codeOf(slack.postMessage("CARCH", { text: "x" }))).toBe("channel_unreachable:is_archived");
    expect(await codeOf(slack.updateMessage("CPUB", "1.000001", { text: "x" }))).toBe(
      "message_not_found:message_not_found",
    );
    expect(await codeOf(client("xoxb-sim-unknown").authTest())).toBe("auth_failed:invalid_auth");
    await script([{ action: "slack.token", token: "xoxb-sim-noscope", scopes: ["channels:read"] }]);
    expect(await codeOf(client("xoxb-sim-noscope").postMessage("CPUB", { text: "x" }))).toBe(
      "auth_failed:missing_scope",
    );
    await script([{ action: "slack.revoke" }]);
    expect(await codeOf(slack.authTest())).toBe("auth_failed:token_revoked");
  });

  it("archived mid-flow, parent deleted, and a 429 with Retry-After", async () => {
    const slack = client();
    const { ts } = await slack.postMessage("CPUB", { text: "status" });
    await script([{ action: "slack.delete_message", channel: "CPUB", ts }]);
    expect(await codeOf(slack.updateMessage("CPUB", ts, { text: "x" }))).toBe("message_not_found:message_not_found");
    await script([{ action: "slack.archive", channel: "CPUB" }]);
    expect(await codeOf(slack.postMessage("CPUB", { text: "x" }))).toBe("channel_unreachable:is_archived");
    await script([{ action: "slack.rate_limit", method: "chat.postMessage", retryAfter: "3" }]);
    let limited: ChatError | undefined;
    try {
      await slack.postMessage("CPRIV", { text: "x" });
    } catch (error) {
      limited = error as ChatError;
    }
    expect(limited?.code).toBe("rate_limited");
    expect(limited?.retryAfterMs).toBe(3000);
    expect((await slack.postMessage("CPRIV", { text: "after" })).ts).toMatch(/^\d+\.\d{6}$/);
  });

  it("refuses a JSON body on read methods, as Slack does", async () => {
    const response = await sim.dispatch(
      simRequest(
        "POST",
        `${SLACK_PREFIX}/conversations.info`,
        { channel: "CPUB" },
        { authorization: `Bearer ${SIM_SLACK_TOKEN}`, "content-type": "application/json" },
      ),
    );
    expect(JSON.parse(String(response.body))).toEqual({ ok: false, error: "invalid_arguments" });
    expect(sim.state.part<SlackState>("slack")!.messages).toHaveLength(0);
  });
});
