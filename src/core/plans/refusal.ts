export type PlanRefusalCode = "plan_number_missing" | "plan_not_approved" | "plan_too_large";

/** A plan-documents refusal before a run starts; nothing has been written. */
export class PlanRefusedError extends Error {
  constructor(
    readonly code: PlanRefusalCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "PlanRefusedError";
  }
}

/** What a caller that maps RepositorySetRefusedError returns for a plan refusal. */
export function refusalOf(err: unknown): { error: string; message: string } | undefined {
  return err instanceof PlanRefusedError ? { error: err.code, message: err.message } : undefined;
}
