import { dependencyCacheTaskNote, type DependencyCacheReport, type RunRepositoryInput } from "../coding/protocol.js";

/**
 * The line both workers add to every agent's prompt about package refusals: pip and uv don't say
 * why the registry refused a package, so the agent is pointed at `wardby-packages`
 * (src/coding-worker/wardby-packages.mjs), which asks the registry, and at `wardby-packages plan`
 * for pip, which has no hook to verify a pinned requirements file first. Kept out of protocol.ts, which
 * is the worker's input contract and must match the pinned driver image.
 */
export const PACKAGE_REFUSALS_TASK_NOTE =
  "If a package install fails without saying why (pip: `from versions: none`; uv: `403 Forbidden`), run `wardby-packages`: it lists the packages this run's package registry refused, and what to do about each. A refused package can't be fetched any other way. Before installing a fully pinned requirements file with pip, run `wardby-packages plan <file>` so the packages it pins are allowed; uv does this itself.";

/**
 * The prompt line for a run with extra repositories (#537): every folder under /repos, whether it is
 * read-only, and how to describe each pull request. Undefined for a single-repository run.
 */
export function repositoriesTaskNote(repositories: readonly RunRepositoryInput[] | undefined): string | undefined {
  if (!repositories || repositories.length === 0) return undefined;
  return [
    'This run has more than one repository. /workspace is the default repository (pullRequests name: "workspace").',
    ...repositories.map(
      (r) =>
        `- ${r.path}: ${r.repository} at ${r.commit.slice(0, 7)}, ${r.access === "read" ? "read-only" : "writable"}`,
    ),
    "None of them has Git history. Wardby opens one pull request per writable repository you change; describe each in pullRequests (name, description, optional title and mergeOrder 1-99). A changed repository without an entry gets your summary.",
  ].join("\n");
}

/** Everything a worker adds to the agent's prompt after the task. */
export function workerTaskNote(
  report: DependencyCacheReport | undefined,
  repositories?: readonly RunRepositoryInput[],
): string {
  return [repositoriesTaskNote(repositories), dependencyCacheTaskNote(report), PACKAGE_REFUSALS_TASK_NOTE]
    .filter(Boolean)
    .join("\n\n");
}
