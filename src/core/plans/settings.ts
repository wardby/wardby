import type { PrismaClient } from "#prisma";
import { codingOverrideAllowed } from "../coding-override.js";
import { atLeast, effectiveAccess } from "../grants.js";
import type { PlanDocument, PlanDocumentInput } from "../../coding/profile.js";

export type PlanSettingsDb = Pick<PrismaClient, "principal" | "agent" | "resourceGrant">;

export function planFolderFor(setting: Pick<PlanDocument, "path">, n: number): string {
  if (!setting.path) throw new Error("plan_path_missing");
  return setting.path.replace("{n}", String(n));
}

/**
 * Save-time check of an agent's planDocument setting: every reviewer (and the
 * final approver) exists and can read the agent; a build hand-off names a
 * coding agent with buildFromPlan that the planner's owner may execute and
 * give task text to. Fills reviewers with the owner when absent (R20).
 */
export async function checkPlanDocumentSetting(
  db: PlanSettingsDb,
  agent: { id: string; ownerId: string | null },
  setting: PlanDocumentInput,
): Promise<PlanDocument> {
  if (!agent.ownerId) throw new Error("plan_reviewer_invalid");
  const reviewers = [...new Set(setting.reviewers ?? [agent.ownerId])];
  const named = [...new Set([...reviewers, ...(setting.finalApproverId ? [setting.finalApproverId] : [])])];
  const found = await db.principal.findMany({ where: { id: { in: named } }, select: { id: true } });
  if (found.length !== named.length) throw new Error("plan_reviewer_invalid");
  for (const id of named) {
    const access = await effectiveAccess(db, "agent", { id: agent.id, ownerId: agent.ownerId }, id);
    if (!atLeast("agent", access, "read")) throw new Error("plan_reviewer_invalid");
  }
  if (setting.onApproved === "build") {
    const builder = await db.agent.findUnique({
      where: { id: setting.builderAgentId! },
      include: { codingProfile: { select: { buildFromPlan: true, allowWebhookTaskOverride: true } } },
    });
    if (!builder || builder.kind !== "coding" || !builder.codingProfile?.buildFromPlan) {
      throw new Error("plan_builder_invalid");
    }
    const access = await effectiveAccess(db, "agent", builder, agent.ownerId);
    if (!atLeast("agent", access, "execute") || !codingOverrideAllowed(agent.ownerId, builder)) {
      throw new Error("plan_builder_invalid");
    }
  }
  return { ...setting, reviewers };
}
