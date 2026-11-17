/**
 * Where the plan build chain (R13, C3) is registered. Kept apart from approval.ts so the shared
 * run-end event (workflow-run-events.ts), which every terminal write reaches, can call it without
 * importing the approval module and its dependencies.
 */
import type { PrismaClient } from "#prisma";

/** What the build chain reads and writes (C3, C4). */
export type PlanChainDb = Pick<PrismaClient, "planSet" | "codingRun">;

/** A merge starts the next ticket, after checking the builder again (R12: plans/settings.ts). */
export type PlanChainMergeDb = PlanChainDb & Pick<PrismaClient, "principal" | "agent" | "resourceGrant">;

/** The build chain (R13): built by `createPlanChainHook(deps)` in composition (C3). */
export interface PlanChainHook {
  /**
   * A pull request closed (pr_closed, or the state sync settling a missed one): a merged PR of the
   * chain's run starts the next ticket; one closed unmerged stops the chain.
   */
  onMerged(db: PlanChainMergeDb, pr: { repository: string; number: number; merged: boolean }): Promise<void>;
  /**
   * A run ended (the shared run-end event): the chain's run that did not succeed, or opened no PR, stops
   * it; a fix round of a ticket whose PR already merged starts the next ticket (R12: the builder is
   * checked again, so this needs the settings tables too).
   */
  onTicketFinished(db: PlanChainMergeDb, runId: string): Promise<void>;
  /** `@<handle> build ticket <t>` on the plan's issue (C4). */
  buildTicketFromComment(
    db: PlanChainMergeDb,
    input: { repository: string; number: number; ticket: number; starterName: string },
  ): Promise<"started" | "refused" | "none">;
}

let chainHook: PlanChainHook | undefined;

export function setPlanChainHook(next: PlanChainHook | undefined): void {
  chainHook = next;
}

export function planChainHook(): PlanChainHook | undefined {
  return chainHook;
}
