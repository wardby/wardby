/**
 * A principal's own code-review host identity (GitHub today). Repository
 * authorization checks the agent owner's access through this identity (see
 * core/repo-access.ts), so linking it is the first step before linking a
 * repository or setting a coding agent's repository. Each tool acts only on
 * the caller; an operator can list and unlink anyone's with
 * `wardby auth host-account`.
 */
import { REVIEW_HOST_PROVIDERS, type ReviewHostProvider } from "../../providers/review-host/types.js";
import {
  confirmHostIdentityLink,
  HostLinkError,
  startHostIdentityLink,
  userCallbackPath,
} from "../../core/host-identity-links.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { canonicalUrl } from "../transport/http-limits.js";
import { textResult } from "./text-result.js";

const PROVIDER_PROP = { type: "string", enum: [...REVIEW_HOST_PROVIDERS] };

function asMcpError(err: unknown): unknown {
  return err instanceof HostLinkError ? new McpError(err.status, err.message) : err;
}

/** The HTTP origin the host's browser callback must reach, or null over stdio (no canonical URI). */
function callbackOrigin(canonicalUri: string): string | null {
  try {
    return canonicalUrl(canonicalUri).origin;
  } catch {
    return null;
  }
}

export function registerHostAccountTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "link_host_account",
    scope: "agents:write",
    description:
      "Links your GitHub account to your wardby identity, so agents you own can be given repositories your GitHub account can access. " +
      "Call it with no confirmationCode to get an authorizeUrl; open that in a browser signed in to GitHub. The page you land on shows a " +
      "one-time code: call link_host_account again with confirmationCode set to it (within 10 minutes).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: PROVIDER_PROP,
        confirmationCode: { type: "string", minLength: 1, maxLength: 32 },
      },
    },
    handler: async (args: { provider?: ReviewHostProvider; confirmationCode?: string }, ctx) => {
      const provider = args.provider ?? "github";
      try {
        if (args.confirmationCode !== undefined) {
          const linked = await confirmHostIdentityLink({
            db: ctx.db,
            principalId: ctx.principal.id,
            provider,
            confirmationCode: args.confirmationCode,
          });
          return textResult({ linked: true, provider, login: linked.login });
        }
        const authorizer = ctx.providers.hostUserAuthorizers?.[provider];
        if (!authorizer) {
          throw new McpError(
            400,
            "GitHub account linking is not configured on this deployment: an operator must set GITHUB_APP_CLIENT_ID and " +
              "GITHUB_APP_CLIENT_SECRET (see docs/code-review-agents.md).",
          );
        }
        const origin = callbackOrigin(ctx.canonicalUri);
        if (!origin) {
          throw new McpError(
            400,
            "Linking needs wardby's HTTP transport (the GitHub callback is served at MCP_CANONICAL_URI); " +
              "use an MCP client connected over HTTP, or ask an operator.",
          );
        }
        const started = await startHostIdentityLink({
          db: ctx.db,
          authorizer,
          principalId: ctx.principal.id,
          redirectUri: `${origin}${userCallbackPath(provider)}`,
        });
        return textResult({
          authorizeUrl: started.authorizeUrl,
          expiresAt: started.expiresAt.toISOString(),
          next:
            "Open authorizeUrl in a browser signed in to the GitHub account to link. Then call link_host_account " +
            "with confirmationCode set to the code the page shows.",
        });
      } catch (err) {
        throw asMcpError(err);
      }
    },
  });

  mcp.registerTool({
    name: "get_host_account",
    scope: "agents:read",
    description: "Shows the GitHub account linked to your wardby identity, if any.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    handler: async (_args: Record<string, never>, ctx) => {
      const identities = await ctx.db.hostIdentity.findMany({
        where: { principalId: ctx.principal.id },
        orderBy: { provider: "asc" },
      });
      return textResult({
        accounts: identities.map((i) => ({
          provider: i.provider,
          login: i.login,
          hostUserId: i.hostUserId,
          linkedAt: i.linkedAt,
        })),
      });
    },
  });

  mcp.registerTool({
    name: "unlink_host_account",
    scope: "agents:write",
    description:
      "Unlinks your GitHub account. Repositories your agents were given through its access stop working until you link again.",
    inputSchema: { type: "object", additionalProperties: false, properties: { provider: PROVIDER_PROP } },
    handler: async (args: { provider?: ReviewHostProvider }, ctx) => {
      const provider = args.provider ?? "github";
      const { count } = await ctx.db.hostIdentity.deleteMany({ where: { principalId: ctx.principal.id, provider } });
      await ctx.db.hostIdentityLinkRequest.deleteMany({ where: { principalId: ctx.principal.id, provider } });
      return textResult({ unlinked: count > 0 });
    },
  });
}
