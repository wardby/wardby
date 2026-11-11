/**
 * Whether a run hook takes an event: its `events` list (empty = every kind),
 * and for run_completed its `statuses` (empty = every terminal status) and
 * `runs` ("top_level" skips child runs). The other kinds' emitters already
 * decide which runs they cover, so `statuses` and `runs` don't apply to them.
 */
export interface HookFilter {
  events: readonly string[];
  statuses: readonly string[];
  runs: string;
}

export function hookWants(
  hook: HookFilter,
  kind: string,
  payload: { status?: unknown; parentRunId?: unknown },
): boolean {
  if (hook.events.length > 0 && !hook.events.includes(kind)) return false;
  if (kind !== "run_completed") return true;
  if (hook.statuses.length > 0 && !hook.statuses.includes(String(payload.status))) return false;
  const child = typeof payload.parentRunId === "string" && payload.parentRunId.length > 0;
  return !child || hook.runs === "all";
}
