export interface PlanFileWireLike {
  path: string;
  contentBase64: string;
}
export type PlanFolderResult =
  | { status: "ok"; files: PlanFileWireLike[]; skipped: string[]; skippedUnnamed: number }
  | { status: "error"; error: "plan_too_large" | "plan_folder_invalid" };
export declare const PLAN_ROOT: "/tmp/wardby-plan";
export declare const PLAN_LIMITS: Readonly<{
  maxFiles: 200;
  maxFileBytes: 1048576;
  maxTotalBytes: 8388608;
  maxPathBytes: 512;
  maxDepth: 4;
  maxSkipped: 50;
}>;
export declare function isSafePlanPath(path: string): boolean;
export declare function placePlanFiles(root: string, files: readonly PlanFileWireLike[]): Promise<void>;
export declare function collectPlanFolder(root: string): Promise<PlanFolderResult>;
