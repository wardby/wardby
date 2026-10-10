/**
 * Slack Web API client for workflow notifications: chat.postMessage,
 * chat.update, conversations.info, auth.test. Plain fetch (JSON bodies for
 * writes, form-encoded for reads), bot token. Every failure becomes a ChatError with a normalized code the
 * dispatcher acts on; Slack's own error string is kept for the operator.
 */
import type { SlackConfig } from "../../config/providers.js";
import { ChatError, type ChatErrorCode, type ChatMessage, type ChatProvider } from "./types.js";

const CHANNEL_UNREACHABLE = new Set(["channel_not_found", "not_in_channel", "is_archived"]);
const AUTH_FAILED = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "missing_scope",
]);
const TIMEOUT_MS = 10_000;

function classify(slackError: string): ChatErrorCode {
  if (CHANNEL_UNREACHABLE.has(slackError)) return "channel_unreachable";
  if (AUTH_FAILED.has(slackError)) return "auth_failed";
  if (slackError === "message_not_found") return "message_not_found";
  if (slackError === "ratelimited") return "rate_limited";
  return "transient";
}

export class SlackChatProvider implements ChatProvider {
  readonly name = "slack" as const;

  constructor(
    private readonly config: SlackConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * `form` for read methods (conversations.info, auth.test): Slack accepts JSON
   * bodies only on write methods and answers a read method's JSON body with
   * invalid_arguments.
   */
  private async call(
    method: string,
    body: Record<string, unknown>,
    encoding: "json" | "form" = "json",
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.apiBaseUrl}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.botToken}`,
          "content-type": encoding === "json" ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded",
        },
        body:
          encoding === "json"
            ? JSON.stringify(body)
            : new URLSearchParams(Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]))).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ChatError("transient", err instanceof Error ? err.message : String(err));
    }
    if (res.status === 429) {
      const seconds = Number(res.headers.get("retry-after") ?? "1");
      throw new ChatError(
        "rate_limited",
        "ratelimited",
        (Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000,
      );
    }
    if (!res.ok) throw new ChatError("transient", `http_${res.status}`);
    const json = (await res.json().catch(() => ({ ok: false, error: "invalid_json" }))) as Record<string, unknown>;
    if (json.ok !== true) {
      const slackError = typeof json.error === "string" ? json.error : "unknown_error";
      throw new ChatError(classify(slackError), slackError);
    }
    return json;
  }

  private messageBody(msg: ChatMessage): Record<string, unknown> {
    return {
      text: msg.text,
      ...(msg.blocks ? { blocks: msg.blocks } : {}),
      ...(this.config.customize && msg.username ? { username: msg.username } : {}),
      ...(this.config.customize && msg.iconEmoji ? { icon_emoji: msg.iconEmoji } : {}),
    };
  }

  async postMessage(channelId: string, msg: ChatMessage, opts: { threadTs?: string; broadcast?: boolean } = {}) {
    const json = await this.call("chat.postMessage", {
      channel: channelId,
      ...this.messageBody(msg),
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
      ...(opts.threadTs && opts.broadcast ? { reply_broadcast: true } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    return { ts: String(json.ts) };
  }

  async updateMessage(channelId: string, ts: string, msg: ChatMessage): Promise<void> {
    await this.call("chat.update", { channel: channelId, ts, ...this.messageBody(msg) });
  }

  async channelInfo(channel: string) {
    try {
      const json = await this.call("conversations.info", { channel }, "form");
      const c = json.channel as { id: string; name: string; is_private?: boolean };
      return { id: c.id, name: c.name, isPrivate: c.is_private === true };
    } catch (err) {
      if (err instanceof ChatError && err.code === "channel_unreachable") return null;
      throw err;
    }
  }

  async authTest() {
    const json = await this.call("auth.test", {}, "form");
    return { team: String(json.team), botUserId: String(json.user_id) };
  }
}
