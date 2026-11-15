/**
 * The one projection of a run's extra repositories (CodingRunRepository rows)
 * that leaves the control plane, shared by get_run and the viewer run detail.
 * It names the columns it reads and maps them to refs, commits, pull request
 * links and the outcome only: the stored `result` itself never leaves.
 */
import type { Prisma } from "#prisma";
import { codeProviderOf, pullRequestWebUrl } from "./code-host.js";
import { publicCodingRunResult } from "./protocol.js";

/** The columns the projection reads; use it as the `select` of the query. */
export const RUN_REPOSITORY_SELECT = {
  name: true,
  access: true,
  asRemote: true,
  repository: true,
  requestedRef: true,
  resolvedSha: true,
  pullRequestNumber: true,
  resultBranch: true,
  result: true,
} satisfies Prisma.CodingRunRepositorySelect;

export type RunRepositoryRow = Prisma.CodingRunRepositoryGetPayload<{ select: typeof RUN_REPOSITORY_SELECT }>;

export interface PublicRunRepository {
  name: string;
  access: "read" | "write";
  /** Fetched as a git remote in the run's history instead of mounted as a folder (#536). */
  asRemote: boolean;
  repository: string;
  requestedRef: string | null;
  resolvedSha: string | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  resultBranch: string | null;
  outcome: string | null;
}

export function publicRunRepository(r: RunRepositoryRow): PublicRunRepository {
  return {
    name: r.name,
    access: r.access === "write" ? "write" : "read",
    asRemote: r.asRemote,
    repository: r.repository,
    requestedRef: r.requestedRef ?? null,
    resolvedSha: r.resolvedSha ?? null,
    pullRequestNumber: r.pullRequestNumber ?? null,
    pullRequestUrl:
      r.pullRequestNumber != null
        ? pullRequestWebUrl(codeProviderOf(r.repository), r.repository, r.pullRequestNumber)
        : null,
    resultBranch: r.resultBranch ?? null,
    outcome: publicCodingRunResult(r.result)?.outcome ?? null,
  };
}
