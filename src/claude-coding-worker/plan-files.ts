import { base64Length, isSafePlanPath, PLAN_FILES_LIMITS } from "../coding/protocol.js";
import type { PlanFolderResult } from "../coding-worker/plan-folder.mjs";

type Failure = {
  status: "error";
  error: "plan_too_large" | "plan_folder_invalid" | "plan_tool_unavailable" | "plan_files_failed";
};

/** The tool runner's answers are checked as untrusted input; nothing they say is ever logged. */
export async function collectPlanFilesViaToolRunner(session: {
  list(): Promise<unknown>;
  read(path: string): Promise<unknown>;
}): Promise<PlanFolderResult | Failure> {
  try {
    const listed = (await session.list()) as Record<string, unknown> | null;
    if (listed?.ok === false) {
      return listed.reason === "plan_too_large" || listed.reason === "plan_folder_invalid"
        ? { status: "error", error: listed.reason }
        : { status: "error", error: "plan_files_failed" };
    }
    const paths = listed?.paths;
    const skipped = listed?.skipped;
    const skippedUnnamed = listed?.skippedUnnamed;
    if (
      listed?.ok !== true ||
      !Array.isArray(paths) ||
      !Array.isArray(skipped) ||
      typeof skippedUnnamed !== "number" ||
      !paths.every((p) => typeof p === "string" && isSafePlanPath(p)) ||
      !skipped.every((p) => typeof p === "string" && isSafePlanPath(p)) ||
      skipped.length > PLAN_FILES_LIMITS.maxSkipped
    ) {
      return { status: "error", error: "plan_files_failed" };
    }
    if (paths.length > PLAN_FILES_LIMITS.maxFiles) return { status: "error", error: "plan_too_large" };
    const files: { path: string; contentBase64: string }[] = [];
    let total = 0;
    for (const path of paths as string[]) {
      const read = (await session.read(path)) as Record<string, unknown> | null;
      const content = read?.content_base64;
      if (read?.ok !== true || typeof content !== "string") return { status: "error", error: "plan_files_failed" };
      if (content.length > base64Length(PLAN_FILES_LIMITS.maxFileBytes)) {
        return { status: "error", error: "plan_too_large" };
      }
      total += Buffer.from(content, "base64").length;
      if (total > PLAN_FILES_LIMITS.maxTotalBytes) return { status: "error", error: "plan_too_large" };
      files.push({ path, contentBase64: content });
    }
    return { status: "ok", files, skipped: skipped as string[], skippedUnnamed };
  } catch (error) {
    return error instanceof Error && error.message === "plan_tool_unavailable"
      ? { status: "error", error: "plan_tool_unavailable" }
      : { status: "error", error: "plan_files_failed" };
  }
}
