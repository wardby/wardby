import type { PrismaClient } from "#prisma";
import { grantedIds } from "../grants.js";
import { isReviewState, type ReviewState } from "./review-state.js";

export interface ListedDocument {
  id: string;
  title: string;
  kind: "document" | "design";
  ownerId: string;
  agentId: string | null;
  agentName: string | null;
  repository: string | null;
  path: string | null;
  updatedAt: Date;
  latestVersion: number;
  reviewState: ReviewState;
}

/**
 * The documents and designs `principalId` owns or was granted read access to, newest first, at most
 * `limit`. One query for every caller (MCP list_documents, the Viewer's /admin/api/documents). It lists
 * ownership and grants only: the operator bypass that effectiveAccess gives admins does not widen it.
 * Plan documents count too when the principal owns or holds any grant on their plan set's access agent
 * (the rule access.ts applies per document); `ownedOnly` leaves them out. `planNumber` keeps only the
 * documents of plan sets with that number. Titles of agent-linked documents were redacted when written.
 */
export async function listDocumentsFor(
  db: PrismaClient,
  principalId: string,
  opts: { ownedOnly?: boolean; agentId?: string; repository?: string; planNumber?: number; limit: number },
): Promise<{ rows: ListedDocument[]; truncated: boolean }> {
  const granted = opts.ownedOnly ? [] : await grantedIds(db, "document", principalId, "read");
  const viaAgent = opts.ownedOnly ? [] : await grantedIds(db, "agent", principalId, "read");
  const found = await db.document.findMany({
    where: {
      OR: [
        { ownerId: principalId },
        { id: { in: granted } },
        ...(opts.ownedOnly
          ? []
          : [{ planSet: { accessAgent: { OR: [{ ownerId: principalId }, { id: { in: viaAgent } }] } } }]),
      ],
      ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
      ...(opts.repository !== undefined ? { repository: opts.repository } : {}),
      ...(opts.planNumber !== undefined ? { planSet: { number: opts.planNumber } } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: opts.limit + 1,
    select: {
      id: true,
      title: true,
      kind: true,
      ownerId: true,
      agentId: true,
      agent: { select: { name: true } },
      repository: true,
      path: true,
      updatedAt: true,
      reviewState: true,
      currentVersion: { select: { number: true } },
    },
  });
  return {
    rows: found.slice(0, opts.limit).map((d) => ({
      id: d.id,
      title: d.title,
      kind: d.kind === "design" ? "design" : "document",
      ownerId: d.ownerId,
      agentId: d.agentId,
      agentName: d.agent?.name ?? null,
      repository: d.repository,
      path: d.path,
      updatedAt: d.updatedAt,
      latestVersion: d.currentVersion?.number ?? 0,
      reviewState: isReviewState(d.reviewState) ? d.reviewState : "draft",
    })),
    truncated: found.length > opts.limit,
  };
}
