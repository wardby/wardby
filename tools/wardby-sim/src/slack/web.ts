// TEST ONLY (wardby-sim). The four Slack Web API methods wardby calls, mounted at /slack/api:
// auth.test, conversations.info, chat.postMessage, chat.update. A stateful workspace with the
// state model of src/providers/chat/fake.ts (channels, posted messages with ts/thread_ts,
// updates), plus the behaviour the real API has (Slack's documentation, unverified):
// - Bearer auth: none → not_authed, unknown → invalid_auth, revoked → token_revoked;
// - scopes: chat:write to post/update, channels:read (public) / groups:read (private) to read
//   a channel → missing_scope with needed/provided;
// - channels: public, private, archived, and ones the bot is not in (posting there:
//   not_in_channel for public, channel_not_found for private); unknown → channel_not_found;
// - chat.update of an unknown ts → message_not_found, of another user's → cant_update_message;
// - read methods with a JSON body → invalid_arguments (Slack takes JSON on writes only);
// - HTTP 429 with Retry-After through `slack.rate_limit`.
import { header, json, jsonBody, record, textOf, type SimRequest, type SimResponse } from "../http.js";
import { Router } from "../router.js";
import type { RouteContext, ScriptAction, SimService } from "../service.js";
import type { SimState } from "../state.js";

export const SLACK_PREFIX = "/slack/api";
export const SIM_SLACK_TOKEN = "xoxb-sim-0000000000-wardby";

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  isMember: boolean;
}
export interface SlackMessage {
  channel: string;
  ts: string;
  threadTs?: string;
  text: string;
  blocks?: unknown;
  user: string;
  username?: string;
  iconEmoji?: string;
  replyBroadcast?: boolean;
  edits: { text: string; blocks?: unknown }[];
  deleted: boolean;
}

export class SlackState {
  team = "Sim Workspace";
  teamId = "TSIM00001";
  botUserId = "USIMBOT01";
  tokens = new Map<string, { scopes: string[]; revoked: boolean }>();
  channels = new Map<string, SlackChannel>();
  messages: SlackMessage[] = [];
  private clock = 1_790_000_000;
  private seq = 0;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.tokens = new Map([
      [SIM_SLACK_TOKEN, { scopes: ["chat:write", "channels:read", "groups:read"], revoked: false }],
    ]);
    this.channels = new Map();
    this.messages = [];
    this.seq = 0;
  }

  nextTs(): string {
    this.seq += 1;
    return `${this.clock}.${String(this.seq).padStart(6, "0")}`;
  }

  channel(idOrName: string): SlackChannel | undefined {
    const key = idOrName.replace(/^#/, "");
    return this.channels.get(key) ?? [...this.channels.values()].find((c) => c.name === key);
  }
}

function fail(error: string, extra: Record<string, unknown> = {}): SimResponse {
  return json({ ok: false, error, ...extra });
}

/** Form or JSON arguments; `json` says which encoding the caller used. */
function args(req: SimRequest): { values: Record<string, unknown>; json: boolean } {
  const type = (header(req, "content-type") ?? "").toLowerCase();
  if (type.includes("application/json")) return { values: record(jsonBody(req)), json: true };
  const query = new URLSearchParams(req.rawBody.toString("utf8"));
  return { values: Object.fromEntries(query.entries()), json: false };
}

export function createSlackService(): SimService {
  const slack = new SlackState();
  const authorize = (req: SimRequest, ctx: RouteContext, needed: string[]): SimResponse | null => {
    const match = /^Bearer\s+(.+)$/i.exec(header(req, "authorization") ?? "");
    if (!match) return fail("not_authed");
    const token = slack.tokens.get(match[1]);
    if (!token) return fail("invalid_auth");
    if (token.revoked) return fail("token_revoked");
    ctx.principal("slack-bot");
    if (needed.length > 0 && !needed.some((scope) => token.scopes.includes(scope))) {
      return fail("missing_scope", { needed: needed.join(","), provided: token.scopes.join(",") });
    }
    return null;
  };

  const router = new Router()
    .on("POST", "/auth.test", (req, _p, ctx) => {
      const denied = authorize(req, ctx, []);
      if (denied) return denied;
      if (args(req).json) return fail("invalid_arguments");
      return json({
        ok: true,
        url: "https://sim.slack.invalid/",
        team: slack.team,
        team_id: slack.teamId,
        user: "wardby",
        user_id: slack.botUserId,
        bot_id: "BSIM00001",
      });
    })
    .on("POST", "/conversations.info", (req, _p, ctx) => {
      const { values, json: isJson } = args(req);
      const denied = authorize(req, ctx, []);
      if (denied) return denied;
      if (isJson) return fail("invalid_arguments");
      const channel = slack.channel(textOf(values.channel));
      if (!channel || (channel.isPrivate && !channel.isMember)) return fail("channel_not_found");
      const scopeDenied = authorize(req, ctx, [channel.isPrivate ? "groups:read" : "channels:read"]);
      if (scopeDenied) return scopeDenied;
      return json({
        ok: true,
        channel: {
          id: channel.id,
          name: channel.name,
          is_private: channel.isPrivate,
          is_archived: channel.isArchived,
          is_member: channel.isMember,
        },
      });
    })
    .on("POST", "/chat.postMessage", (req, _p, ctx) => {
      const denied = authorize(req, ctx, ["chat:write"]);
      if (denied) return denied;
      const { values } = args(req);
      const channel = slack.channel(textOf(values.channel));
      if (!channel || (channel.isPrivate && !channel.isMember)) return fail("channel_not_found");
      if (channel.isArchived) return fail("is_archived");
      if (!channel.isMember) return fail("not_in_channel");
      const text = textOf(values.text);
      if (!text && !values.blocks) return fail("no_text");
      const threadTs = textOf(values.thread_ts) || undefined;
      if (threadTs && !slack.messages.some((m) => m.channel === channel.id && m.ts === threadTs && !m.deleted)) {
        return fail("thread_not_found");
      }
      const message: SlackMessage = {
        channel: channel.id,
        ts: slack.nextTs(),
        ...(threadTs ? { threadTs } : {}),
        text,
        ...(values.blocks !== undefined ? { blocks: values.blocks } : {}),
        user: slack.botUserId,
        ...(typeof values.username === "string" ? { username: values.username } : {}),
        ...(typeof values.icon_emoji === "string" ? { iconEmoji: values.icon_emoji } : {}),
        ...(values.reply_broadcast === true ? { replyBroadcast: true } : {}),
        edits: [],
        deleted: false,
      };
      slack.messages.push(message);
      return json({
        ok: true,
        channel: channel.id,
        ts: message.ts,
        message: {
          type: "message",
          text,
          user: message.user,
          ts: message.ts,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        },
      });
    })
    .on("POST", "/chat.update", (req, _p, ctx) => {
      const denied = authorize(req, ctx, ["chat:write"]);
      if (denied) return denied;
      const { values } = args(req);
      const channel = slack.channel(textOf(values.channel));
      if (!channel || (channel.isPrivate && !channel.isMember)) return fail("channel_not_found");
      if (channel.isArchived) return fail("is_archived");
      const message = slack.messages.find((m) => m.channel === channel.id && m.ts === textOf(values.ts));
      if (!message || message.deleted) return fail("message_not_found");
      if (message.user !== slack.botUserId) return fail("cant_update_message");
      message.edits.push({ text: message.text, ...(message.blocks !== undefined ? { blocks: message.blocks } : {}) });
      message.text = textOf(values.text, message.text);
      if (values.blocks !== undefined) message.blocks = values.blocks;
      return json({ ok: true, channel: channel.id, ts: message.ts, text: message.text });
    });

  const actions: Record<string, ScriptAction> = {
    "slack.channel": async (a) => {
      const id = textOf(a.id) || `C${String(slack.channels.size + 1).padStart(8, "0")}`;
      slack.channels.set(id, {
        id,
        name: textOf(a.name, id.toLowerCase()),
        isPrivate: a.private === true,
        isArchived: a.archived === true,
        isMember: a.member !== false,
      });
      return { id };
    },
    "slack.archive": async (a) => {
      const channel = slack.channel(textOf(a.channel));
      if (!channel) throw new Error("no such channel");
      channel.isArchived = true;
      return {};
    },
    "slack.token": async (a) => {
      slack.tokens.set(textOf(a.token, SIM_SLACK_TOKEN), {
        scopes: Array.isArray(a.scopes) ? a.scopes.map(String) : ["chat:write", "channels:read", "groups:read"],
        revoked: a.revoked === true,
      });
      return {};
    },
    "slack.revoke": async (a) => {
      const token = slack.tokens.get(textOf(a.token, SIM_SLACK_TOKEN));
      if (!token) throw new Error("no such token");
      token.revoked = true;
      return {};
    },
    "slack.delete_message": async (a) => {
      const message = slack.messages.find((m) => m.channel === textOf(a.channel) && m.ts === textOf(a.ts));
      if (!message) throw new Error("no such message");
      message.deleted = true;
      return {};
    },
    "slack.messages": async (a) => ({
      messages: slack.messages.filter((m) => !a.channel || m.channel === slack.channel(textOf(a.channel))?.id),
    }),
    "slack.rate_limit": async (a, { state }) =>
      state.faults.add({
        service: "slack",
        method: "POST",
        path: textOf(a.method) ? `/${textOf(a.method)}` : "/*",
        mode: a.mode === "sticky" ? "sticky" : "once",
        response: {
          status: 429,
          headers: { "retry-after": textOf(a.retryAfter, "1"), "content-type": "application/json" },
          body: JSON.stringify({ ok: false, error: "ratelimited" }),
        },
      }),
  };

  return {
    name: "slack",
    prefix: SLACK_PREFIX,
    handle: (req, ctx) => router.handle(req, ctx),
    routes: () => router.routes(),
    actions,
    init: (state: SimState) => {
      if (!state.part("slack")) state.register("slack", slack);
    },
  };
}
