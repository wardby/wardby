/**
 * After-commit review hooks, in order (#646, spec §3.2): the plan hook (approval, build chain), then the review
 * action hook (the router). They run after the action's transaction commits; neither can undo or fail it.
 */
import type { PrismaClient } from "#prisma";
import { planReviewHook } from "../plans/approval.js";

export interface ReviewAction {
  documentId: string;
  /** Every review event the action wrote, in order (chooseOption writes several). */
  eventIds: string[];
  /** The person who acted, or null for an agent or guest. */
  actorId: string | null;
}
export type ReviewActionHook = (db: PrismaClient, action: ReviewAction) => Promise<void>;

let actionHook: ReviewActionHook | undefined;

export function setReviewActionHook(next: ReviewActionHook | undefined): void {
  actionHook = next;
}

export async function runReviewHooks(db: PrismaClient, action: ReviewAction): Promise<void> {
  await planReviewHook()?.(db, action.documentId, action.actorId);
  try {
    await actionHook?.(db, action);
  } catch {
    // The action hook logs its own failures by name; a review action is never failed by it.
  }
}
