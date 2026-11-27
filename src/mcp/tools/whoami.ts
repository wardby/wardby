import { PERMISSION_TIER, check, isOwnerAll } from "../../authz/index.js";
import { principalNames } from "../../core/documents/comments.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

/**
 * Who this MCP call is: the principal, the token's identity claims, the wardby roles resolved for
 * this request, the scopes the token grants, and the permissions those two allow together (a request
 * needs both). Never the token itself. Compare `principal.subject`
 * with the browser's GET /web/whoami to see whether an MCP and a browser sign-in are one person.
 */
export function registerWhoamiTool(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "whoami",
    description:
      "Show who this MCP connection is: your Wardby principal (id, subject, shown name), the identity claims " +
      "of your token (sub, uid, cid, client_id, azp when present), your Wardby roles for this request, the " +
      "scopes your token grants, your teams, and `permissions`: what you can actually do, because a call needs " +
      "both a scope and a role (a token with admin scopes but only the viewer role can't act as admin). " +
      "ownerAll is true when you act as owner of every owner's resources. Never returns the token. Compare principal.subject with " +
      "/web/whoami in the browser: if they differ, the two sign-ins are different Wardby people.",
    permission: "agents:read",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    handler: async (_args, ctx) => {
      const names = await principalNames(ctx.db, [ctx.principal.id]);
      return textResult({
        principal: {
          id: ctx.principal.id,
          subject: ctx.principal.subject,
          name: names.get(ctx.principal.id) ?? null,
        },
        // The MCP path always maps the access token's `sub` to the principal subject.
        subjectFrom: { claim: "sub" },
        token: ctx.tokenIdentity ?? null,
        roles: [...(ctx.roles ?? [])].sort(),
        scopes: [...ctx.scopes].sort(),
        // What the scopes and roles allow together: authorize() requires both.
        permissions: Object.keys(PERMISSION_TIER)
          .filter((permission) => check(ctx, [permission]) === null)
          .sort(),
        ownerAll: isOwnerAll(ctx),
        teamIds: [...(ctx.teamIds ?? [])],
        operator: ctx.operator ?? false,
      });
    },
  });
}
