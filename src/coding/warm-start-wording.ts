/**
 * The run step line a continuation on a launcher with warm rounds gets (Substrate,
 * SUBSTRATE_WARM_ROUNDS): whether it resumed the previous round's workspace and session, and if not
 * why. Fixed text only, from a fixed reason list (WarmColdReason): no value from the run, the
 * repository or the backend ever reaches it.
 */
import type { WarmColdReason, WarmOutcome } from "../providers/jobs/types.js";

export const WARM_ADOPTED_LINE = "Resumed the previous round's workspace and session";
export const WARM_COLD_PREFIX = "Started a fresh workspace: ";

/** Why a round started fresh, as the step line says it. */
export const WARM_COLD_REASON_TEXT: Readonly<Record<WarmColdReason, string>> = {
  not_parked: "the previous round was not kept",
  expired: "the previous round's sandbox expired",
  branch_moved: "the branch changed since the previous round",
  fingerprint_changed: "the agent's settings changed since the previous round",
  actor_missing: "the previous round's sandbox was no longer available",
  actor_not_suspended: "the previous round's sandbox was no longer available",
  capacity: "there was no room to resume the previous round",
};

/** The step's callId: one warm-start line per run. */
export const WARM_START_STEP_ID = "said:wardby-warm-start";

/** The step line for `outcome`; undefined for a reason outside the fixed list (nothing is written then). */
export function warmStartLine(outcome: WarmOutcome): string | undefined {
  if (outcome.adopted === true) return WARM_ADOPTED_LINE;
  const reason = Object.hasOwn(WARM_COLD_REASON_TEXT, outcome.reason) ? WARM_COLD_REASON_TEXT[outcome.reason] : null;
  return reason ? `${WARM_COLD_PREFIX}${reason}` : undefined;
}
