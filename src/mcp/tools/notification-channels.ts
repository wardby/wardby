/**
 * NotificationChannel CRUD — admin-approved links from a Slack channel to a
 * Jira project or to an agent (native or coding), so wardby's workflow dispatcher
 * (core/notification-dispatcher.ts) knows where to post a card's lifecycle:
 * picked up, PR opened, review verdict, fix rounds, merge. Outbound only —
 * wardby never reads a channel's history, and linking posts nothing.
 *
 * Same trust model as link_issue_project (src/mcp/tools/issue-projects.ts):
 * wardby cannot verify a caller's own Slack workspace access (one bot token
 * for the whole deployment, no per-user OAuth), so link/unlink/test need
 * agents:admin with the admin role, and the approver is stamped on the
 * link. Exactly one of projectKey/agentId is the link's subject (enforced
 * again by a DB CHECK constraint); `events` narrows which of the
 * workflow event kinds post to it (empty/omitted = all); private Slack
 * channels always need /invite @<app> before the bot can see or post to
 * them. See docs/private/2026-10-08-slack-workflow-notifications-design.md §8.
 */
import { Prisma } from "#prisma";
import { requireAgentAccess } from "../auth/access.js";
import { requireScope } from "../auth/resource-server.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { PROJECT_KEY } from "../../providers/issue-tracker/types.js";
import { ChatError, type ChatProviderName } from "../../providers/chat/types.js";
import { WORKFLOW_EVENT_KINDS, type WorkflowEventKind } from "../../core/workflow-events.js";
import { textResult } from "./text-result.js";

const CHAT_PROVIDERS = ["slack"] as const;
/** Slack channel id: C… (public) or G… (private), case-insensitive, normalized upper-case. */
const CHANNEL_ID = /^[CG][A-Z0-9]{2,20}$/i;

type LinkArgs = {
  provider?: ChatProviderName;
  channel: string;
  projectKey?: string;
  issueProvider?: "jira";
  agentId?: string;
  events?: WorkflowEventKind[];
  includeCost?: boolean;
};

function normalizeProjectKey(projectKey: string): string {
  const key = projectKey.trim().toUpperCase();
  if (!PROJECT_KEY.test(key)) throw new McpError(400, `invalid projectKey "${projectKey}"`);
  return key;
}

function normalizeChannelId(channel: string): string {
  const id = channel.trim().toUpperCase();
  if (!CHANNEL_ID.test(id)) {
    throw new McpError(400, "Pass the channel id (C…); find it in the channel's details in Slack.");
  }
  return id;
}

export function registerNotificationChannelTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "link_notification_channel",
    scope: "agents:write",
    description:
      "Links a Slack channel to a Jira project or to an agent (native or coding), so wardby posts that project's or " +
      "agent's workflow updates there: a card picked up, a PR opened, a review verdict, fix rounds, and the merge (one thread per card). " +
      "Outbound only — wardby never reads the channel's history, and nothing in Slack starts work. Admin-approved " +
      "(agents:admin with the admin role), the same trust model as link_issue_project: wardby cannot verify a caller's " +
      "own Slack workspace access, so an admin approves every link and is stamped as its authorizer. " +
      "Exactly one of projectKey or agentId is the link's subject: a project link (with issueProvider, default jira) " +
      "matches events for issues in that project; an agent link matches events for that agent's runs. " +
      "channel is the Slack channel id (C… for public, G… for private), never a #name — find it in the channel's " +
      "details in Slack. Private channels always need /invite @<app> before the bot can see or post to them. " +
      "events narrows which of the workflow event kinds post to this link; empty or omitted means all. " +
      "includeCost appends the run's spend line to messages. Re-linking the same channel + subject replaces events and " +
      "includeCost and clears any previously recorded delivery error — always send the full desired state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { type: "string", enum: [...CHAT_PROVIDERS] },
        channel: { type: "string", minLength: 1, maxLength: 64 },
        projectKey: { type: "string", minLength: 1, maxLength: 255 },
        issueProvider: { type: "string", enum: ["jira"] },
        agentId: { type: "string" },
        events: { type: "array", items: { type: "string", enum: [...WORKFLOW_EVENT_KINDS] }, uniqueItems: true },
        includeCost: { type: "boolean" },
      },
      required: ["channel"],
    },
    handler: async (args: LinkArgs, ctx) => {
      requireScope(ctx, ctx.canonicalUri, "agents:admin");
      const provider = args.provider ?? "slack";
      const chat = ctx.providers.chat?.[provider];
      if (!chat) {
        throw new McpError(
          400,
          "Slack is not configured (WARDBY_SLACK_BOT_TOKEN). See help article errors/slack-not-configured.",
        );
      }
      const hasProject = args.projectKey !== undefined;
      const hasAgent = args.agentId !== undefined;
      if (hasProject === hasAgent) {
        throw new McpError(400, "Give exactly one of projectKey or agentId.");
      }
      let issueProvider: string | null = null;
      let projectKey: string | null = null;
      let agentId: string | null = null;
      if (hasProject) {
        issueProvider = args.issueProvider ?? "jira";
        projectKey = normalizeProjectKey(args.projectKey as string);
      } else {
        agentId = args.agentId as string;
        const agent = await ctx.db.agent.findUnique({ where: { id: agentId } });
        if (!agent) throw new McpError(404, `Agent "${agentId}" not found.`);
      }
      const channelId = normalizeChannelId(args.channel);
      // `info` is undefined when channelInfo can't be validated at all
      // (missing_scope: no channels:read/groups:read — accept the id
      // unvalidated); any other auth failure (revoked or invalid token) is a
      // real error the operator must fix before linking. `info` is
      // null when the bot genuinely cannot see the channel (an error, not a
      // validation gap) — kept out of the try/catch below so the 400 for
      // "bot cannot see this channel" isn't routed through ChatError handling.
      let info: { id: string; name: string; isPrivate: boolean } | null | undefined;
      try {
        info = await chat.channelInfo(channelId);
      } catch (err) {
        if (!(err instanceof ChatError && err.code === "auth_failed")) throw err;
        if (err.slackError !== "missing_scope") {
          throw new McpError(
            400,
            `Slack rejected the bot token (${err.slackError}). See help article errors/slack-auth-failed.`,
          );
        }
        info = undefined;
      }
      if (info === null) {
        throw new McpError(
          400,
          `The bot cannot see channel ${channelId}: invite it with /invite @<app> (private channels always need ` +
            "this). See errors/slack-channel-unreachable.",
        );
      }
      const channelName = info ? info.name : null;
      const events = [...new Set(args.events ?? [])];
      const includeCost = args.includeCost ?? false;
      const fields = {
        channelName,
        events,
        includeCost,
        lastError: null,
        lastErrorAt: null,
        authorizedById: ctx.principal.id,
        authorizedAt: new Date(),
      };
      // Can't use Prisma `upsert` here: Postgres treats NULLs as distinct
      // within a unique index, and this link's unique keys
      // (provider, channelId, issueProvider, projectKey) / (provider,
      // channelId, agentId) each have two columns that are null for the
      // other subject kind — so the where-unique input Prisma generates for
      // this compound key never matches an existing row the way a fully
      // non-null key would. Find the existing row explicitly instead, then
      // update it by id or create.
      const subjectWhere = hasProject
        ? { provider, channelId, issueProvider, projectKey }
        : { provider, channelId, agentId };
      const existing = await ctx.db.notificationChannel.findFirst({ where: subjectWhere });
      let link;
      if (existing) {
        link = await ctx.db.notificationChannel.update({ where: { id: existing.id }, data: fields });
      } else {
        try {
          link = await ctx.db.notificationChannel.create({
            data: { provider, channelId, issueProvider, projectKey, agentId, ...fields },
          });
        } catch (err) {
          if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
          // Lost a create race: another concurrent link_notification_channel
          // call for the same channel + subject committed first. Re-linking
          // an existing link is normal, documented behavior (it replaces
          // events/includeCost and clears lastError) — so re-query and
          // update that row instead of surfacing the race as an error.
          const raced = await ctx.db.notificationChannel.findFirst({ where: subjectWhere });
          if (!raced) throw err;
          link = await ctx.db.notificationChannel.update({ where: { id: raced.id }, data: fields });
        }
      }
      return textResult({ link });
    },
  });

  mcp.registerTool({
    name: "unlink_notification_channel",
    scope: "agents:write",
    description: "Removes a notification channel link. Admin only (agents:admin with the admin role).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    handler: async (args: { id: string }, ctx) => {
      requireScope(ctx, ctx.canonicalUri, "agents:admin");
      const { count } = await ctx.db.notificationChannel.deleteMany({ where: { id: args.id } });
      return textResult({ unlinked: count > 0 });
    },
  });

  mcp.registerTool({
    name: "list_notification_channels",
    scope: "agents:read",
    description:
      "Lists notification channel links, each with its pending and failed delivery counts. Filter by projectKey, " +
      "agentId, or channel (the Slack channel id). Listing an agent's own links needs read access to that agent; " +
      "listing without agentId (every link, including project links) needs agents:admin with the admin role.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectKey: { type: "string", minLength: 1, maxLength: 255 },
        agentId: { type: "string" },
        channel: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
    handler: async (args: { projectKey?: string; agentId?: string; channel?: string }, ctx) => {
      if (args.agentId !== undefined) {
        await requireAgentAccess(ctx, args.agentId, "read");
      } else {
        requireScope(ctx, ctx.canonicalUri, "agents:admin");
      }
      const where: Record<string, unknown> = {};
      if (args.agentId !== undefined) where.agentId = args.agentId;
      if (args.projectKey !== undefined) where.projectKey = normalizeProjectKey(args.projectKey);
      if (args.channel !== undefined) where.channelId = normalizeChannelId(args.channel);
      const links = await ctx.db.notificationChannel.findMany({ where, orderBy: { createdAt: "asc" } });
      // Counts only for the listed links' own (provider, channel) pairs, so a
      // caller never learns about deliveries to channels it cannot list.
      const pairKey = (r: { provider: string; channelId: string }) => `${r.provider}\u0000${r.channelId}`;
      const pairs = [
        ...new Map(links.map((l) => [pairKey(l), { provider: l.provider, channelId: l.channelId }])).values(),
      ];
      const counts =
        pairs.length === 0
          ? []
          : await ctx.db.notificationDelivery.groupBy({
              by: ["provider", "channelId", "state"],
              where: { state: { in: ["pending", "failed"] }, OR: pairs },
              _count: true,
            });
      const byChannel = new Map<string, { pending: number; failed: number }>();
      for (const row of counts) {
        const entry = byChannel.get(pairKey(row)) ?? { pending: 0, failed: 0 };
        if (row.state === "pending") entry.pending = row._count;
        else if (row.state === "failed") entry.failed = row._count;
        byChannel.set(pairKey(row), entry);
      }
      const channels = links.map((l) => ({
        ...l,
        pending: byChannel.get(pairKey(l))?.pending ?? 0,
        failed: byChannel.get(pairKey(l))?.failed ?? 0,
      }));
      return textResult({ channels });
    },
  });

  mcp.registerTool({
    name: "test_notification_channel",
    scope: "agents:write",
    description:
      "Posts a one-off confirmation message to a linked channel, to prove the bot can write there before relying on it " +
      "for workflow notifications (a private channel needs /invite @<app> first; a channel the bot can't reach " +
      "surfaces its error immediately instead of silently queueing). Admin only (agents:admin with the admin role).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    handler: async (args: { id: string }, ctx) => {
      requireScope(ctx, ctx.canonicalUri, "agents:admin");
      const link = await ctx.db.notificationChannel.findUnique({ where: { id: args.id } });
      if (!link) throw new McpError(404, `Notification channel link "${args.id}" not found.`);
      const chat = ctx.providers.chat?.[link.provider as ChatProviderName];
      if (!chat) {
        throw new McpError(
          400,
          "Slack is not configured (WARDBY_SLACK_BOT_TOKEN). See help article errors/slack-not-configured.",
        );
      }
      try {
        await chat.postMessage(link.channelId, { text: "✅ wardby is connected to this channel." });
      } catch (err) {
        if (!(err instanceof ChatError)) throw err;
        if (err.code === "channel_unreachable") {
          await ctx.db.notificationChannel.update({
            where: { id: link.id },
            data: { lastError: err.slackError, lastErrorAt: new Date() },
          });
        }
        throw new McpError(400, `${err.code}: ${err.slackError}`);
      }
      // The bot can post here again: clear any recorded delivery error.
      if (link.lastError !== null || link.lastErrorAt !== null) {
        await ctx.db.notificationChannel.update({
          where: { id: link.id },
          data: { lastError: null, lastErrorAt: null },
        });
      }
      return textResult({ tested: true });
    },
  });
}
