/**
 * Server-held connections a public tool may use once an admin grants them
 * (#529). Slack is the only one: a run hook on a granted public tool calls
 * `slack.post`, and the bridge lands here, where the channel is checked
 * against the grant's scope, the text masked by exact value against the hook
 * agent's secrets, and the message posted with the server's own Slack client.
 * The bot token stays inside that client; the tool only gets `{ ts }`.
 */
import type { PrismaClient } from "#prisma";
import { ChatError, type ChatProvider } from "../../providers/chat/types.js";
import type { SlackConnection } from "../../sandbox/host-functions.js";
import { logger as defaultLogger, type Logger } from "../logger.js";

export const TOOL_CONNECTIONS = ["slack"] as const;
export type ToolConnectionName = (typeof TOOL_CONNECTIONS)[number];

export function isToolConnectionName(value: unknown): value is ToolConnectionName {
  return typeof value === "string" && (TOOL_CONNECTIONS as readonly string[]).includes(value);
}

/** Any channel with a Slack notification link (an admin approved posting there). */
export const LINKED_CHANNELS = "linked";
/** Any channel the bot is in. */
export const ANY_CHANNEL = "*";

const CHANNEL_ID = /^[CG][A-Z0-9]{2,20}$/i;

/**
 * A grant's channel scope: channel ids (upper-cased, de-duplicated), or
 * exactly ["linked"], or exactly ["*"].
 */
export function parseChannelScope(channels: unknown): { ok: true; channels: string[] } | { ok: false; error: string } {
  if (!Array.isArray(channels) || channels.length === 0) {
    return { ok: false, error: 'channels must be a non-empty list: channel ids, or ["linked"], or ["*"].' };
  }
  if (channels.some((c) => typeof c !== "string")) return { ok: false, error: "channels must be strings." };
  const values = channels as string[];
  const modes = values.filter((c) => c === LINKED_CHANNELS || c === ANY_CHANNEL);
  if (modes.length > 0) {
    if (values.length !== 1) {
      return { ok: false, error: `"${modes[0]}" must be the only entry in channels.` };
    }
    return { ok: true, channels: [values[0]] };
  }
  const bad = values.find((c) => !CHANNEL_ID.test(c));
  if (bad !== undefined) {
    return { ok: false, error: `"${bad.slice(0, 40)}" is not a Slack channel id (C… or G…).` };
  }
  return { ok: true, channels: [...new Set(values.map((c) => c.toUpperCase()))] };
}

/** Whether `channel` (upper-case) is inside `scope`. `isLinked` is only asked for the "linked" mode. */
export async function channelAllowed(
  scope: readonly string[],
  channel: string,
  isLinked: (channel: string) => Promise<boolean>,
): Promise<boolean> {
  if (scope.length === 1 && scope[0] === ANY_CHANNEL) return true;
  if (scope.length === 1 && scope[0] === LINKED_CHANNELS) return isLinked(channel);
  return scope.includes(channel);
}

export interface SlackConnectionInput {
  chat: ChatProvider;
  /** The grant's channels, as stored (already parsed). */
  scope: readonly string[];
  db: Pick<PrismaClient, "notificationChannel">;
  /** Exact-value redaction against every secret attached to the hook's agent. */
  mask: (text: string) => string;
  /** Ids for the log line; the text is never logged. */
  ids: { toolId: string; hookId: string };
  logger?: Logger;
}

/** The host side of slack.post for one hook delivery. */
export function buildSlackConnection(input: SlackConnectionInput): SlackConnection {
  const log = (input.logger ?? defaultLogger).child({ module: "system-tools", ...input.ids });
  const isLinked = async (channel: string) =>
    (await input.db.notificationChannel.count({ where: { provider: "slack", channelId: channel } })) > 0;
  return {
    async post(channel, text, threadTs) {
      if (!(await channelAllowed(input.scope, channel, isLinked))) {
        log.warn({ channel, ok: false, errorCode: "slack_channel_not_granted" }, "slack.post refused");
        throw new Error(`slack_channel_not_granted: ${channel} is outside this tool's Slack grant`);
      }
      try {
        const { ts } = await input.chat.postMessage(channel, { text: input.mask(text) }, threadTs ? { threadTs } : {});
        log.info({ channel, ok: true }, "slack.post");
        return { ts };
      } catch (err) {
        // Only Slack's own error code crosses back: never the request content.
        const code = err instanceof ChatError ? `${err.code}:${err.slackError}` : "transient:request_failed";
        log.warn({ channel, ok: false, errorCode: code }, "slack.post failed");
        // No `cause`: the original error may quote the request (the text), and
        // a cause rides along wherever this error is logged.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`slack_error: ${code}`);
      }
    },
  };
}
