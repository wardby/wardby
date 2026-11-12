/**
 * GET /admin/api/documents: the documents and designs the authenticated admin owns or was granted
 * read access to. The same query as MCP list_documents (core/documents/list.ts). Metadata only: no
 * content, no comments. Titles of agent-linked documents were redacted by exact secret value when
 * they were written (createDocument), so no secret value is read or sent here.
 */
import type { PrismaClient } from "#prisma";
import { listDocumentsFor } from "../core/documents/list.js";
import type { DocumentList } from "./api-schema.js";

export async function loadViewerDocuments(
  db: PrismaClient,
  principalId: string,
  opts: { agentId?: string; repository?: string; limit: number },
): Promise<DocumentList> {
  const { rows, truncated } = await listDocumentsFor(db, principalId, opts);
  return {
    documents: rows.map((d) => ({
      id: d.id,
      title: d.title,
      kind: d.kind,
      mine: d.ownerId === principalId,
      agent: d.agentId && d.agentName !== null ? { id: d.agentId, name: d.agentName } : null,
      repository: d.repository,
      path: d.path,
      updatedAt: d.updatedAt.toISOString(),
      latestVersion: d.latestVersion,
      pagePath: `/d/${d.id}`,
    })),
    truncated,
  };
}
