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
