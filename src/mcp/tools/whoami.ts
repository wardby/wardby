import { principalNames } from "../../core/documents/comments.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

/**
 * Who this MCP call is: the principal, the token's identity claims, the wardby roles resolved for
 * this request and the scopes the token grants. Never the token itself. Compare `principal.subject`
 * with the browser's GET /web/whoami to see whether an MCP and a browser sign-in are one person.
 */
export function registerWhoamiTool(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "whoami",
    description:
      "Show who this MCP connection is: your Wardby principal (id, subject, shown name), the identity claims " +
      "of your token (sub, uid, cid, client_id, azp when present), your Wardby roles for this request, the " +
      "scopes your token grants, and your teams. Never returns the token. Compare principal.subject with " +
      "/web/whoami in the browser: if they differ, the two sign-ins are different Wardby people.",
    scope: "agents:read",
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
        teamIds: [...(ctx.teamIds ?? [])],
        operator: ctx.operator ?? false,
      });
    },
  });
}
