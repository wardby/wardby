import { z } from "zod";
import { atLeast, accessFor } from "../grants.js";
import { checkReviewersCanReadAgent, type PlanSettingsDb } from "../plans/settings.js";

export const DOCUMENT_TOOL_PREFIX = "doc_";
const Id = z.string().min(1).max(128);

export const DocumentToolsSchema = z
  .object({
    access: z.enum(["read", "write"]),
    reviewers: z.array(Id).min(1).max(50).optional(),
    finalApproverId: Id.nullable().optional(),
    maxNewPerRun: z.number().int().min(1).max(20).optional(),
    plans: z.array(Id).max(20).optional(),
  })
  .strict();
export type DocumentToolsInput = z.infer<typeof DocumentToolsSchema>;
export interface DocumentToolsSetting {
  access: "read" | "write";
  reviewers: string[];
  finalApproverId: string | null;
  maxNewPerRun: number;
  plans: string[];
}

const invalid = (field: string): never => {
  throw new Error("document_tools_invalid", { cause: field });
};

/**
 * Save-time check of a native agent's documentTools setting: only native agents take it; every reviewer
 * (and the final approver) exists and can read the agent; every plan names a planner agent with a
 * planDocument setting that the saving principal may execute. Fills reviewers with the owner when absent.
 */
export async function checkDocumentToolsSetting(
  db: PlanSettingsDb,
  agent: { id: string; ownerId: string | null; kind: "native" | "coding" },
  savedBy: string,
  input: DocumentToolsInput,
): Promise<DocumentToolsSetting> {
  if (agent.kind !== "native") invalid("kind");
  if (!agent.ownerId) invalid("reviewers");
  const ownerId = agent.ownerId as string;
  const reviewers = [...new Set(input.reviewers ?? [ownerId])];
  const finalApproverId = input.finalApproverId ?? null;
  const named = [...new Set([...reviewers, ...(finalApproverId ? [finalApproverId] : [])])];
  if (!(await checkReviewersCanReadAgent(db, { id: agent.id, ownerId }, named))) invalid("reviewers");
  const plans = [...new Set(input.plans ?? [])];
  for (const plannerId of plans) {
    const planner = await db.agent.findUnique({
      where: { id: plannerId },
      select: { id: true, ownerId: true, codingProfile: { select: { planDocument: true } } },
    });
    if (!planner?.codingProfile?.planDocument) return invalid("plans");
    if (!atLeast("agent", await accessFor(db, "agent", planner, savedBy), "execute")) invalid("plans");
  }
  return { access: input.access, reviewers, finalApproverId, maxNewPerRun: input.maxNewPerRun ?? 5, plans };
}

/** The stored setting, or null when off or no longer valid shape (fails closed). */
export function parseStoredDocumentTools(value: unknown): DocumentToolsSetting | null {
  if (value === null || value === undefined) return null;
  const parsed = DocumentToolsSchema.safeParse(value);
  if (!parsed.success || !parsed.data.reviewers) return null;
  return {
    access: parsed.data.access,
    reviewers: parsed.data.reviewers,
    finalApproverId: parsed.data.finalApproverId ?? null,
    maxNewPerRun: parsed.data.maxNewPerRun ?? 5,
    plans: parsed.data.plans ?? [],
  };
}
