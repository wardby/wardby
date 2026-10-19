import { dependencyCacheTaskNote, type DependencyCacheReport } from "../coding/protocol.js";

/**
 * The line both workers add to every agent's prompt about package refusals: pip and uv don't say
 * why the registry refused a package, so the agent is pointed at `wardby-packages`
 * (src/coding-worker/wardby-packages.mjs), which asks the registry, and at `wardby-packages plan`
 * for pip, which has no hook to verify a pinned requirements file first. Kept out of protocol.ts, which
 * is the worker's input contract and must match the pinned driver image.
 */
export const PACKAGE_REFUSALS_TASK_NOTE =
  "If a package install fails without saying why (pip: `from versions: none`; uv: `403 Forbidden`), run `wardby-packages`: it lists the packages this run's package registry refused, and what to do about each. A refused package can't be fetched any other way. Before installing a fully pinned requirements file with pip, run `wardby-packages plan <file>` so the packages it pins are allowed; uv does this itself.";

/** Everything a worker adds to the agent's prompt after the task. */
export function workerTaskNote(report: DependencyCacheReport | undefined): string {
  return [dependencyCacheTaskNote(report), PACKAGE_REFUSALS_TASK_NOTE].filter(Boolean).join("\n\n");
}
