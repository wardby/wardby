/** Which root run and which of its repositories a wardby pull request belongs to (#537 §4). */
import type { PrismaClient } from "#prisma";
import { codeProviderOf, normalizeHostedRepository } from "../coding/code-host.js";
import { publicCodingRunResult } from "../coding/protocol.js";
import { TERMINAL_RUN_STATUSES } from "./host-status.js";

/** A root run's pull request: its default repository's, or one writable extra's (by the row's name). */
export type RunPullRequestTarget =
  | { kind: "default"; repository: string; pullRequestNumber: number }
  | { kind: "extra"; name: string; repository: string; pullRequestNumber: number };

export type ResolveRunPullRequestResult =
  | { ok: true; root: { runId: string; baseRef: string; headRef: string }; repo: RunPullRequestTarget }
  | { ok: false; reason: "unknown_run" | "other_repository" | "no_pull_request" | "other_owner" };

type RunPullRequestDb = Pick<PrismaClient, "codingRun" | "codingRunRepository">;

const ROOT_SELECT = {
  runId: true,
  rootCodingRunId: true,
  repository: true,
  baseRef: true,
  headRef: true,
  result: true,
  run: { select: { agent: { select: { ownerId: true } } } },
} as const;

/** Repository ids compare the way the host does; an id that is not a hosted one compares case-insensitively. */
export function sameRepository(a: string, b: string): boolean {
  try {
    return normalizeHostedRepository(a) === normalizeHostedRepository(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

/** The pull request number of an opened or updated result, else undefined. */
function pullRequestNumberOf(value: unknown): number | undefined {
  const result = publicCodingRunResult(value);
  return result && (result.outcome === "pull_request_opened" || result.outcome === "pull_request_updated")
    ? result.pullRequestNumber
    : undefined;
}

/**
 * The default repository's pull request number as the newest continuation of the root recorded it,
 * for a root whose own default publish had no changes or failed and whose follow-up opened it later
 * (spec §3/§4). Undefined when no continuation opened or updated one.
 */
export async function newestDefaultPullRequest(
  db: Pick<PrismaClient, "codingRun">,
  rootRunId: string,
): Promise<number | undefined> {
  const continuations = await db.codingRun.findMany({
    where: { rootCodingRunId: rootRunId },
    select: { result: true },
    orderBy: { createdAt: "desc" },
  });
  for (const continuation of continuations) {
    const number = pullRequestNumberOf(continuation.result);
    if (number !== undefined) return number;
  }
  return undefined;
}

/** The default repository's pull request: the root's own result wins, else the newest continuation's. */
async function defaultPullRequest(
  db: Pick<PrismaClient, "codingRun">,
  root: { runId: string; result: unknown },
): Promise<number | undefined> {
  return pullRequestNumberOf(root.result) ?? (await newestDefaultPullRequest(db, root.runId));
}

/** The writable rows of the root family (the root and its continuations) that recorded a pull request, oldest first. */
function familyPullRequestRows(db: Pick<PrismaClient, "codingRunRepository">, rootRunId: string) {
  return db.codingRunRepository.findMany({
    where: {
      access: "write",
      pullRequestNumber: { not: null },
      codingRun: { OR: [{ runId: rootRunId }, { rootCodingRunId: rootRunId }] },
    },
    select: { name: true, provider: true, repository: true, pullRequestNumber: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * The root run a pull request's body marker leads to, and which of the root's writable repositories
 * the pull request is in: the default one (its PR on the root's result, or a continuation's when
 * the root opened none), or a writable extra (its PR on a row of the root or any continuation). A
 * read repository is never a target, and the provider must match as well as the repository.
 * `pullRequestNumber`, when given, must be that repository's pull request.
 *
 * `dispatchingOwnerId`, when given (even `null`), fails closed unless the root's opening agent has
 * exactly that owner (a null on either side never matches), as checkContinuation always has.
 */
export async function resolveRunPullRequest(
  db: RunPullRequestDb,
  input: {
    markerRunId: string;
    provider: string;
    repository: string;
    pullRequestNumber?: number;
    dispatchingOwnerId?: string | null;
  },
): Promise<ResolveRunPullRequestResult> {
  const marked = await db.codingRun.findUnique({ where: { runId: input.markerRunId }, select: ROOT_SELECT });
  if (!marked) return { ok: false, reason: "unknown_run" };
  const root = marked.rootCodingRunId
    ? await db.codingRun.findUnique({ where: { runId: marked.rootCodingRunId }, select: ROOT_SELECT })
    : marked;
  if (!root) return { ok: false, reason: "unknown_run" };
  if (input.dispatchingOwnerId !== undefined) {
    const ownerId = root.run?.agent?.ownerId ?? null;
    if (input.dispatchingOwnerId === null || ownerId === null || ownerId !== input.dispatchingOwnerId) {
      return { ok: false, reason: "other_owner" };
    }
  }
  const base = { runId: root.runId, baseRef: root.baseRef, headRef: root.headRef };
  const wanted = (number: number) => input.pullRequestNumber === undefined || input.pullRequestNumber === number;

  if (codeProviderOf(root.repository) === input.provider && sameRepository(root.repository, input.repository)) {
    const number = await defaultPullRequest(db, root);
    if (number === undefined || !wanted(number)) return { ok: false, reason: "no_pull_request" };
    return { ok: true, root: base, repo: { kind: "default", repository: root.repository, pullRequestNumber: number } };
  }

  const inRepository = (row: { provider: string; repository: string }) =>
    row.provider === input.provider && sameRepository(row.repository, input.repository);
  const match = (await familyPullRequestRows(db, root.runId)).find(
    (row) => inRepository(row) && row.pullRequestNumber !== null && wanted(row.pullRequestNumber),
  );
  if (match && match.pullRequestNumber !== null) {
    return {
      ok: true,
      root: base,
      repo: {
        kind: "extra",
        name: match.name,
        repository: match.repository,
        pullRequestNumber: match.pullRequestNumber,
      },
    };
  }
  const writable = await db.codingRunRepository.findMany({
    where: { runId: root.runId, access: "write" },
    select: { provider: true, repository: true },
  });
  return { ok: false, reason: writable.some(inRepository) ? "no_pull_request" : "other_repository" };
}

/** One pull request of a root run's set, on the host that has it. */
export interface RootPullRequest {
  provider: string;
  repository: string;
  number: number;
}

/**
 * Every pull request a root run's set opened so far: the default repository's (the root's own, else
 * the newest continuation's), then each writable extra's recorded on a row of the root family.
 */
export async function rootPullRequests(db: RunPullRequestDb, rootRunId: string): Promise<RootPullRequest[]> {
  const root = await db.codingRun.findUnique({
    where: { runId: rootRunId },
    select: { runId: true, repository: true, result: true },
  });
  const prs: RootPullRequest[] = [];
  if (root) {
    const number = await defaultPullRequest(db, root);
    if (number !== undefined)
      prs.push({ provider: codeProviderOf(root.repository), repository: root.repository, number });
  }
  for (const row of await familyPullRequestRows(db, rootRunId)) {
    if (row.pullRequestNumber !== null) {
      prs.push({ provider: row.provider, repository: row.repository, number: row.pullRequestNumber });
    }
  }
  return prs;
}

/**
 * Whether a follow-up of the root run is already going (#537 §4, one in flight per root run, a
 * single-repository root included): a non-terminal coding continuation of the root, or a
 * non-terminal run whose status comment is on one of the root's pull requests (rootPullRequests),
 * matched on provider, repository and number.
 */
export async function rootFollowUpInFlight(
  db: Pick<PrismaClient, "run" | "codingRunRepository" | "codingRun">,
  rootRunId: string,
): Promise<boolean> {
  const prs = await rootPullRequests(db, rootRunId);
  const busy = await db.run.findFirst({
    where: {
      status: { notIn: [...TERMINAL_RUN_STATUSES] },
      OR: [
        { codingRun: { is: { rootCodingRunId: rootRunId } } },
        ...prs.map((pr) => ({
          hostStatus: {
            is: {
              provider: pr.provider,
              repository: { equals: pr.repository, mode: "insensitive" as const },
              number: pr.number,
            },
          },
        })),
      ],
    },
    select: { id: true },
  });
  return busy !== null;
}
