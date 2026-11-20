import type { Prisma } from "#prisma";

type BranchTx = Pick<Prisma.TransactionClient, "codingRun" | "$queryRaw">;

/** Outcomes that leave a branch (and usually a pull request) in the repository. */
const BRANCH_OUTCOMES: ReadonlySet<string> = new Set(["pull_request_opened", "pull_request_updated", "branch_pushed"]);

/**
 * Whether a run holds its branch name: it is still going, or it left a branch behind. A run that
 * failed, was refused or changed nothing never pushed, so its name is free for the next run.
 */
function holdsBranch(row: { result: unknown; run: { status: string } }): boolean {
  if (row.run.status === "pending" || row.run.status === "running") return true;
  // Only the outcome is read, and not validated as a whole: a result that cannot be parsed may still
  // have pushed, and then the name stays held.
  const outcome = (row.result as { outcome?: unknown } | null)?.outcome;
  return typeof outcome === "string" && BRANCH_OUTCOMES.has(outcome);
}

/** Room left under the 128-character ref component for the `wardby/` prefix and a `-N` repeat suffix. */
const MAX_NAME_LENGTH = 40;
/** Repeats tried before giving up; a ticket run this many times in one repository is not a naming problem. */
const MAX_REPEATS = 99;

/**
 * Reduces free text (a ticket key, a name from the caller) to one safe branch
 * component: letters, digits and single hyphens, at most 40 characters.
 * Undefined when nothing usable is left.
 */
export function branchComponent(raw: string | undefined, options: { lowercase?: boolean } = {}): string | undefined {
  if (!raw) return undefined;
  const text = options.lowercase ? raw.toLowerCase() : raw;
  const part = text
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/, "");
  return part === "" ? undefined : part;
}

/** `wardby/<name>` for the caller's name, else the issue key; undefined when neither gives one (the run-id fallback). */
export function namedHeadRefBase(input: { requestedName?: string; issueKey?: string }): string | undefined {
  // The caller may type the full branch (`wardby/readme`); the prefix is added here, so drop theirs.
  const requested = input.requestedName?.trim().replace(/^wardby\//i, "");
  const name = branchComponent(requested, { lowercase: true }) ?? branchComponent(input.issueKey);
  return name === undefined ? undefined : `wardby/${name}`;
}

/** Whether `headRef` is `base` or one of its numbered repeats (`base-2`, `base-3`, ...). */
export function isRepeatOf(base: string, headRef: string): boolean {
  return headRef === base || new RegExp(`^${base.replace(/[^A-Za-z0-9/-]/g, "\\$&")}-\\d+$`).test(headRef);
}

/**
 * The branch a fresh coding run pushes: the caller's name, else the linked
 * issue's key (the same for every issue provider), else the run id. A name
 * already held by another run in the same repository (one still going, or one that pushed) gets
 * `-2`, `-3`, ...
 * The key keeps its case so Jira links the branch to the ticket.
 *
 * A caller's name or an issue key takes a transaction-scoped advisory lock on
 * (repository, name), so two runs dispatched at once cannot pick the same name.
 */
export async function chooseHeadRef(
  tx: BranchTx,
  input: { repository: string; runId: string; requestedName?: string; issueKey?: string },
): Promise<string> {
  const base = namedHeadRefBase(input);
  // The run id is unique by construction, so the default name needs no lock or lookup.
  if (base === undefined) return `wardby/run-${input.runId}`;
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${`wardby-coding-branch:${input.repository}:${base}`}))) AS l`;
  const taken = new Set(
    (
      await tx.codingRun.findMany({
        where: { repository: input.repository, headRef: { startsWith: base } },
        select: { headRef: true, result: true, run: { select: { status: true } } },
      })
    )
      .filter(holdsBranch)
      .map((row) => row.headRef),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n <= MAX_REPEATS; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  throw new Error("coding_branch_names_exhausted");
}
