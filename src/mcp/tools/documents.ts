import { z } from "zod";
import type { WardbyMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { createShareLink, listShareLinks, revokeShareLink } from "../../core/documents/share-links.js";
import type { Viewer } from "../../core/documents/access.js";
import { textResult } from "./text-result.js";

const NOT_FOUND = new Set(["document_not_found", "share_link_not_found"]);

/** Maps the documents module's error codes to MCP errors; anything else passes through. */
async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (NOT_FOUND.has(code)) throw new McpError(404, code);
    if (code === "document_access_denied") throw new McpError(403, code);
    if (/^(share_[a-z_]+_invalid)$/.test(code)) throw new McpError(400, code);
    throw error;
  }
}

const viewerOf = (ctx: { principal: { id: string }; operator?: boolean }): Viewer => ({
  kind: "principal",
  principalId: ctx.principal.id,
  ...(ctx.operator === true ? { operator: true } : {}),
});

const createArgs = z.object({
  documentId: z.string().min(1),
  permission: z.enum(["view", "comment"]),
  expiresInDays: z.number().int().min(1).max(90).optional(),
});
const listArgs = z.object({ documentId: z.string().min(1) });
const revokeArgs = z.object({ shareLinkId: z.string().min(1) });

export function registerDocumentTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "create_share_link",
    scope: "documents:write",
    description:
      "Creates a share link for a document you own and returns its URL once; it is never shown again. permission is view or comment; expiresInDays is 1-90 (default 14). Guests choose a name when they open it.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string" },
        permission: { type: "string", enum: ["view", "comment"] },
        expiresInDays: { type: "integer", minimum: 1, maximum: 90 },
      },
      required: ["documentId", "permission"],
    },
    handler: async (args: unknown, ctx) => {
      const input = createArgs.parse(args);
      const created = await mapped(() =>
        createShareLink(ctx.db, {
          documentId: input.documentId,
          viewer: viewerOf(ctx),
          permission: input.permission,
          expiresInDays: input.expiresInDays,
          origin: new URL(ctx.canonicalUri).origin,
        }),
      );
      return textResult({ id: created.id, url: created.url, expiresAt: created.expiresAt.toISOString() });
    },
  });

  mcp.registerTool({
    name: "list_share_links",
    scope: "documents:read",
    description:
      "Lists a document's share links you own: id, permission, expiry, revoked, guest count. URLs are not stored and are never listed.",
    inputSchema: { type: "object", properties: { documentId: { type: "string" } }, required: ["documentId"] },
    handler: async (args: unknown, ctx) => {
      const input = listArgs.parse(args);
      const links = await mapped(() => listShareLinks(ctx.db, { documentId: input.documentId, viewer: viewerOf(ctx) }));
      return textResult(
        links.map((l) => ({
          id: l.id,
          permission: l.permission,
          expiresAt: l.expiresAt.toISOString(),
          revoked: l.revokedAt !== null,
          guestCount: l.guestCount,
        })),
      );
    },
  });

  mcp.registerTool({
    name: "revoke_share_link",
    scope: "documents:write",
    description: "Revokes a share link you own. Guests who came through it are signed out immediately.",
    inputSchema: { type: "object", properties: { shareLinkId: { type: "string" } }, required: ["shareLinkId"] },
    handler: async (args: unknown, ctx) => {
      const input = revokeArgs.parse(args);
      await mapped(() => revokeShareLink(ctx.db, { shareLinkId: input.shareLinkId, viewer: viewerOf(ctx) }));
      return textResult({ revoked: input.shareLinkId });
    },
  });
}
