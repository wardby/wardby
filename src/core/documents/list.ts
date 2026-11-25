import type { Prisma, PrismaClient } from "#prisma";
import { agentGranteeKey, grantedIds } from "../grants.js";
import { agentDocumentAccess } from "./access.js";
import { parseStoredDocumentTools } from "./tools-setting.js";
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

const LISTED_SELECT = {
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
} satisfies Prisma.DocumentSelect;

function toListed(d: Prisma.DocumentGetPayload<{ select: typeof LISTED_SELECT }>): ListedDocument {
  return {
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
  };
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
    select: LISTED_SELECT,
  });
  return {
    rows: found.slice(0, opts.limit).map(toListed),
    truncated: found.length > opts.limit,
  };
}

/**
 * What a native agent can reach (#625): the documents linked to it, those granted to it, and the plan
 * documents of the planners named in its documentTools.plans, each with the access the agent really has
 * (never its owner's). Newest first, at most `limit`; a document the agent cannot read is left out.
 */
export async function listDocumentsForAgent(
  db: PrismaClient,
  agentId: string,
  opts: { limit: number },
): Promise<{ rows: (ListedDocument & { access: "read" | "comment" | "write" })[]; truncated: boolean }> {
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { documentTools: true } });
  const setting = agent ? parseStoredDocumentTools(agent.documentTools) : null;
  if (!setting) return { rows: [], truncated: false };
  const grants = await db.resourceGrant.findMany({
    where: { resourceType: "document", granteeKey: agentGranteeKey(agentId) },
    select: { resourceId: true },
  });
  const where: Prisma.DocumentWhereInput = {
    OR: [
      { agentId },
      { id: { in: grants.map((g) => g.resourceId) } },
      ...(setting.plans.length ? [{ planSet: { agentId: { in: setting.plans } } }] : []),
    ],
  };
  const rows: (ListedDocument & { access: "read" | "comment" | "write" })[] = [];
  const pageSize = opts.limit + 1;
  // Access is computed per row, so a row the agent cannot read is skipped and the next page fills its place.
  for (let cursor: string | undefined; rows.length < pageSize;) {
    const page = await db.document.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { ...LISTED_SELECT, planSetId: true },
    });
    for (const d of page) {
      const access = await agentDocumentAccess(db, { id: d.id, ownerId: d.ownerId, planSetId: d.planSetId }, agentId);
      if (access === "read" || access === "comment" || access === "write") rows.push({ ...toListed(d), access });
      if (rows.length >= pageSize) break;
    }
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }
  return { rows: rows.slice(0, opts.limit), truncated: rows.length > opts.limit };
}
