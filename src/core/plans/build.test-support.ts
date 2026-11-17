/**
 * Plan-set fixtures for the builder tests (spec §7): a set's documents written as rows, each at a
 * chosen version number and review state, without going through publish or review.
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "#prisma";
import { storeVersionFiles } from "../documents/files.js";

export interface FixtureDocument {
  path: string;
  /** Markdown text, or a design's files (paths inside the design folder). */
  content: string | Record<string, string>;
  version: number;
  reviewState?: string;
  removedFromPlan?: boolean;
}

const hashOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A plan set of `plannerId` for `repository` #`number`, its documents owned by `ownerId`; returns the set id. */
export async function createPlanSetFixture(
  db: PrismaClient,
  input: { plannerId: string; ownerId: string; repository: string; number: number; documents: FixtureDocument[] },
): Promise<{ planSetId: string; documentIds: Record<string, string> }> {
  const set = await db.planSet.create({
    data: {
      agentId: input.plannerId,
      repository: input.repository,
      number: input.number,
      store: "wardby",
      createdByRunId: "fixture",
    },
  });
  const documentIds: Record<string, string> = {};
  for (const doc of input.documents) {
    const design = typeof doc.content !== "string";
    const created = await db.document.create({
      data: {
        kind: design ? "design" : "document",
        title: doc.path,
        ownerId: input.ownerId,
        agentId: input.plannerId,
        planSetId: set.id,
        planPath: doc.path,
        removedFromPlan: doc.removedFromPlan ?? false,
        reviewState: doc.reviewState ?? "approved",
      },
    });
    const version = await db.documentVersion.create({
      data: {
        documentId: created.id,
        number: doc.version,
        format: design ? "boards-v1" : "markdown",
        markdown: design ? null : (doc.content as string),
        contentHash: hashOf(doc.content),
        via: "agent",
      },
    });
    if (design) {
      await db.$transaction((tx) =>
        storeVersionFiles(tx, created.id, version.id, doc.content as Record<string, string>),
      );
    }
    await db.document.update({ where: { id: created.id }, data: { currentVersionId: version.id } });
    documentIds[doc.path] = created.id;
  }
  return { planSetId: set.id, documentIds };
}

/** Sets one document's review state (e.g. approving the one still in review). */
export async function setReviewState(db: PrismaClient, documentId: string, reviewState: string): Promise<void> {
  await db.document.update({ where: { id: documentId }, data: { reviewState } });
}
