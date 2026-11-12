/**
 * Admin MCP tools for system tools (#529): make a tool public, and grant or
 * revoke a server connection (Slack) on a public tool. Every one needs
 * agents:admin with the admin role (registerTool's scope check enforces both).
 * The rules live in core/system-tools/admin.ts, shared with the CLI.
 */
import {
  grantToolConnection,
  makeToolPublic,
  revokeToolConnection,
  SystemToolError,
} from "../../core/system-tools/admin.js";
import { isToolConnectionName, parseChannelScope, TOOL_CONNECTIONS } from "../../core/system-tools/connections.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

const STATUS: Record<SystemToolError["code"], number> = {
  tool_not_found: 404,
  tool_already_public: 409,
  public_tool_name_taken: 409,
  tool_used_by_other_owners: 409,
  tool_not_public: 409,
};

/** A core refusal as an MCP error. Agents other owners hold are counted, never named. */
function toMcpError(err: unknown): unknown {
  if (!(err instanceof SystemToolError)) return err;
  return new McpError(STATUS[err.code], err.message);
}

function connectionArg(value: unknown): (typeof TOOL_CONNECTIONS)[number] {
  if (!isToolConnectionName(value)) {
    throw new McpError(400, `connection must be one of: ${TOOL_CONNECTIONS.join(", ")}.`);
  }
  return value;
}

function requireSlackConfigured(ctx: McpRequestContext): void {
  if (!ctx.providers.chat?.slack) {
    throw new McpError(
      409,
      "slack_not_configured: this server has no Slack connection (WARDBY_SLACK_BOT_TOKEN). See help article errors/slack-not-configured.",
    );
  }
}

export function registerSystemToolTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "make_tool_public",
    scope: "agents:admin",
    description:
      "Admins (agents:admin with the admin role): makes a tool public, a system tool. It loses its owner: everyone can see and attach it (never read its code), and only an admin (update_tool, delete_tool) or the operator's CLI can change it. Refused while it runs for an agent owned by someone other than its owner, or when a public tool already has its name. Existing attachments and hooks on the former owner's agents keep working. Records who published it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { toolId: { type: "string" } },
      required: ["toolId"],
    },
    handler: async (args: { toolId: string }, ctx) => {
      try {
        const tool = await makeToolPublic(ctx.db, args.toolId, ctx.principal.id);
        return textResult({
          id: tool.id,
          name: tool.name,
          public: true,
          publishedById: tool.publishedById,
          publishedAt: tool.publishedAt,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  });

  mcp.registerTool({
    name: "grant_tool_connection",
    scope: "agents:admin",
    description:
      'Admins (agents:admin with the admin role): lets a public tool use one of the server\'s own connections from a run hook. "slack": the tool calls slack.post(channel, text, { threadTs }), posting with the server\'s Slack bot; the token never reaches the tool. channels limits where it may post: a list of channel ids, or ["linked"] (any channel with a Slack notification link), or ["*"] (any channel the bot is in). Granting again replaces the channels. Only run hooks get the connection, never an agent\'s own tool calls. See help article system-tools.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        toolId: { type: "string" },
        connection: { type: "string", enum: [...TOOL_CONNECTIONS] },
        channels: { type: "array", items: { type: "string" } },
      },
      required: ["toolId", "connection", "channels"],
    },
    handler: async (args: { toolId: string; connection: string; channels: unknown }, ctx) => {
      const connection = connectionArg(args.connection);
      const scope = parseChannelScope(args.channels);
      if (!scope.ok) throw new McpError(400, scope.error);
      requireSlackConfigured(ctx);
      try {
        const grant = await grantToolConnection(ctx.db, args.toolId, connection, scope.channels, ctx.principal.id);
        return textResult({
          toolId: grant.toolId,
          connection: grant.connection,
          channels: grant.channels,
          grantedById: grant.grantedById,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  });

  mcp.registerTool({
    name: "revoke_tool_connection",
    scope: "agents:admin",
    description:
      "Admins (agents:admin with the admin role): removes a server connection from a public tool. Its next hook delivery gets connection_unavailable from slack.post.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        toolId: { type: "string" },
        connection: { type: "string", enum: [...TOOL_CONNECTIONS] },
      },
      required: ["toolId", "connection"],
    },
    handler: async (args: { toolId: string; connection: string }, ctx) => {
      const connection = connectionArg(args.connection);
      try {
        return textResult({
          toolId: args.toolId,
          connection,
          revoked: await revokeToolConnection(ctx.db, args.toolId, connection),
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  });
}
