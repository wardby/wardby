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
  /**
   * The run the action was made for, when its events record none: a plan publish submits as the plan's owner
   * for the planner run, so routing continues that run's job. Attribution in the events is unchanged.
   */
  actorRunId?: string;
  /**
   * The router hook skips this action: a plan publish routes its documents' submits once, after the last one
   * (runReviewActionHook), so the router starts once and sees the whole plan.
   */
  deferRouting?: boolean;
  /** Set by runReviewHooks: this action completed its plan set's approval (the plan hook claimed it). */
  planApprovalClaimed?: boolean;
}
export type ReviewActionHook = (db: PrismaClient, action: ReviewAction) => Promise<void>;

let actionHook: ReviewActionHook | undefined;

export function setReviewActionHook(next: ReviewActionHook | undefined): void {
  actionHook = next;
}

/** The review action hook (the router) alone, for an action whose per-document hooks already ran. Never throws. */
export async function runReviewActionHook(db: PrismaClient, action: ReviewAction): Promise<void> {
  try {
    await actionHook?.(db, action);
  } catch {
    // The action hook logs its own failures by name.
  }
}

export async function runReviewHooks(db: PrismaClient, action: ReviewAction): Promise<void> {
  const plan = await planReviewHook()?.(db, action.documentId, action.actorId);
  try {
    await actionHook?.(db, plan?.approvalClaimed ? { ...action, planApprovalClaimed: true } : action);
  } catch {
    // The action hook logs its own failures by name; a review action is never failed by it.
  }
}
