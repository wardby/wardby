/**
 * Router settings (#646, spec §2): a router is a native agent with a description (request_work ranks by it) and
 * documentTools (it reads documents); a writer's reviewRouter names a router its owner can execute. Errors are the
 * fixed code review_router_invalid with a fixed cause; nothing is logged.
 */
import type { PrismaClient } from "#prisma";
import { canExecute } from "../documents/access.js";

export type RouterInvalidCause = "description" | "documents" | "kind" | "review_router";

const invalid = (cause: RouterInvalidCause): never => {
  throw new Error("review_router_invalid", { cause });
};

export async function checkRouterSettings(
  db: Pick<PrismaClient, "agent"> & Parameters<typeof canExecute>[0],
  input: {
    agentId: string | null;
    ownerId: string;
    kind: "native" | "coding";
    description: string | null;
    documentTools: unknown;
    router: boolean;
    reviewRouterId: string | null;
  },
): Promise<void> {
  if (input.router) {
    if (input.kind !== "native") invalid("kind");
    if (!input.description || input.description.trim() === "") invalid("description");
    if (input.documentTools === null || input.documentTools === undefined) invalid("documents");
  }
  if (input.reviewRouterId !== null) {
    if (input.reviewRouterId === input.agentId) invalid("review_router");
    const target = await db.agent.findUnique({
      where: { id: input.reviewRouterId },
      select: { id: true, ownerId: true, router: true },
    });
    if (!target?.router || !(await canExecute(db, target, input.ownerId))) invalid("review_router");
  }
}
