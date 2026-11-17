import type { PrismaClient } from "#prisma";
import { isSafePlanPath, PLAN_FILES_LIMITS } from "../protocol.js";

export interface PlanFile {
  path: string;
  content: string;
}

export function assertPlanFilesWithinLimits(files: readonly PlanFile[]): void {
  if (files.length > PLAN_FILES_LIMITS.maxFiles) throw new Error("plan_too_large");
  let total = 0;
  const seen = new Set<string>();
  for (const file of files) {
    if (!isSafePlanPath(file.path) || seen.has(file.path)) throw new Error("plan_path_invalid");
    seen.add(file.path);
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > PLAN_FILES_LIMITS.maxFileBytes) throw new Error("plan_too_large");
    total += bytes;
  }
  if (total > PLAN_FILES_LIMITS.maxTotalBytes) throw new Error("plan_too_large");
}

export async function savePlanInputFiles(
  db: Pick<PrismaClient, "codingRunPlanFile">,
  runId: string,
  files: readonly PlanFile[],
): Promise<void> {
  assertPlanFilesWithinLimits(files);
  if (files.length === 0) return;
  await db.codingRunPlanFile.createMany({
    data: files.map((f) => ({ runId, direction: "input", path: f.path, content: f.content })),
  });
}

export async function loadPlanFiles(
  db: Pick<PrismaClient, "codingRunPlanFile">,
  runId: string,
  direction: "input" | "output",
): Promise<PlanFile[]> {
  return db.codingRunPlanFile.findMany({
    where: { runId, direction },
    orderBy: { path: "asc" },
    select: { path: true, content: true },
  });
}
