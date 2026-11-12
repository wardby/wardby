/**
 * Which extra repositories a coding run gets (#537 §1), and the commits they resolve to (§2).
 * Refusals never echo a caller- or model-written value; they list link names (owner-set).
 */
import type { Prisma } from "#prisma";
import { CodingReadRefSchema, COMMIT_SHA } from "../coding/protocol.js";

export const MAX_REF_FILE_BYTES = 255;
const REF_FILE_READ_BYTES = 1024;

/** A coding agent's set-eligible links: write links without triggers, and read links. */
export const CODING_SET_LINK_FILTER = {
  OR: [
    { access: "write", triggers: { isEmpty: true } },
    { access: "read", triggers: { isEmpty: true } },
  ],
} as const satisfies Prisma.AgentRepositoryWhereInput;

export type RepositorySetRefusalCode =
  "repository_not_listed" | "repository_set_too_large" | "invalid_repositories" | "coding_repositories_unsupported";
export class RepositorySetRefusedError extends Error {
  constructor(
    readonly code: RepositorySetRefusalCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "RepositorySetRefusedError";
  }
}

type RefReason = "missing" | "empty" | "too_long" | "invalid" | "unavailable" | "ref_not_found";
const FILE_REASON_TEXT: Record<Exclude<RefReason, "ref_not_found">, string> = {
  missing: "does not exist at the default repository's base branch",
  empty: "is empty",
  too_long: `is longer than ${MAX_REF_FILE_BYTES} bytes`,
  invalid: "is not a branch, a tag or a 40-hex commit SHA",
  unavailable: "could not be read right now",
};

function refUnreadableMessage(linkName: string, reason: RefReason, where: { path?: string; ref?: string }): string {
  // A ref that came from a file is reported by the file's path only: never the file's content or the
  // value it resolved to (spec §1, secrets rule). A link's own ref is owner-set configuration.
  if (reason === "ref_not_found") {
    return where.path !== undefined
      ? `the ref file ${where.path} for link "${linkName}" names a ref that does not exist.`
      : `link "${linkName}" names ref ${where.ref} and it does not exist.`;
  }
  if (where.path === undefined) {
    return reason === "unavailable"
      ? `link "${linkName}": its ref could not be resolved right now.`
      : `link "${linkName}" has neither a ref nor a ref file.`;
  }
  return `the ref file ${where.path} for link "${linkName}" ${FILE_REASON_TEXT[reason]}.`;
}

export class RepositoryRefUnreadableError extends Error {
  readonly code = "repository_ref_unreadable";
  constructor(
    readonly linkName: string,
    readonly reason: RefReason,
    where: { path?: string; ref?: string },
  ) {
    super(`repository_ref_unreadable: ${refUnreadableMessage(linkName, reason, where)}`);
    this.name = "RepositoryRefUnreadableError";
  }
}

export interface RepositorySetLink {
  id: string;
  name: string;
  provider: string;
  repository: string;
  access: string;
  baseRef: string | null;
  ref: string | null;
  refFromFile: string | null;
  inDefaultSet: boolean;
  createdAt: Date;
}
export interface PlannedRunRepository {
  position: number;
  name: string;
  access: "read" | "write";
  provider: string;
  repository: string;
  requestedRef: string | null;
  refFromFile: string | null;
  linkId: string | null;
  baseRef: string | null;
}
export interface ResolvedRunRepository extends PlannedRunRepository {
  requestedRef: string;
  resolvedSha: string;
}

const sameRepository = (a: { provider: string; repository: string }, b: { provider: string; repository: string }) =>
  a.provider === b.provider && a.repository.toLowerCase() === b.repository.toLowerCase();

export function planRepositorySet(input: {
  links: readonly RepositorySetLink[];
  workspace: { provider: string; repository: string };
  requested?: readonly string[];
  limit: number;
  profileBaseRef: string;
}): PlannedRunRepository[] {
  const eligible = [...input.links]
    .filter((l) => l.access === "read" || l.access === "write")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.name.localeCompare(b.name));
  const byName = new Map(eligible.map((l) => [l.name, l]));
  let chosen: RepositorySetLink[];
  if (input.requested === undefined) {
    chosen = eligible.filter((l) => l.inDefaultSet);
  } else {
    if (new Set(input.requested).size !== input.requested.length) {
      throw new RepositorySetRefusedError("invalid_repositories", "repositories must name each link once.");
    }
    chosen = input.requested.map((name) => {
      const found = byName.get(name);
      if (!found) {
        throw new RepositorySetRefusedError(
          "repository_not_listed",
          `name one of this coding agent's repository links: ${eligible.map((l) => l.name).join(", ")}.`,
        );
      }
      return found;
    });
  }
  // The write link that is the run's /workspace is the default repository, not an extra.
  chosen = chosen.filter((l) => !(l.access === "write" && sameRepository(l, input.workspace)));
  if (chosen.length + 1 > input.limit) {
    throw new RepositorySetRefusedError(
      "repository_set_too_large",
      `this run would have ${chosen.length + 1} repositories; the limit is ${input.limit} (CODING_MAX_RUN_REPOSITORIES).`,
    );
  }
  return chosen.map((l, position) => ({
    position,
    name: l.name,
    access: l.access as "read" | "write",
    provider: l.provider,
    repository: l.repository,
    requestedRef: l.access === "write" ? (l.baseRef ?? input.profileBaseRef) : l.ref,
    refFromFile: l.access === "read" ? l.refFromFile : null,
    linkId: l.id,
    baseRef: l.access === "write" ? (l.baseRef ?? input.profileBaseRef) : null,
  }));
}

export function parseRefFile(
  text: string | null,
): { ok: true; ref: string } | { ok: false; reason: "missing" | "empty" | "too_long" | "invalid" } {
  if (text === null) return { ok: false, reason: "missing" };
  const line = text.trim();
  if (line === "") return { ok: false, reason: "empty" };
  if (Buffer.byteLength(line, "utf8") > MAX_REF_FILE_BYTES) return { ok: false, reason: "too_long" };
  if (/[\r\n]/.test(line)) return { ok: false, reason: "invalid" };
  const parsed = CodingReadRefSchema.safeParse(line);
  return parsed.success ? { ok: true, ref: parsed.data } : { ok: false, reason: "invalid" };
}

export async function resolveRepositorySetRefs(
  planned: readonly PlannedRunRepository[],
  deps: {
    workspace: { repository: string; baseRef: string };
    readFile(input: { repository: string; baseRef: string; path: string; maxBytes: number }): Promise<string | null>;
    resolveRef(input: { repository: string; ref: string; access: "read" | "write" }): Promise<string | null>;
  },
): Promise<ResolvedRunRepository[]> {
  const resolved: ResolvedRunRepository[] = [];
  for (const row of planned) {
    let ref = row.requestedRef;
    if (row.refFromFile !== null) {
      let text: string | null;
      try {
        text = await deps.readFile({ ...deps.workspace, path: row.refFromFile, maxBytes: REF_FILE_READ_BYTES });
      } catch (err) {
        // github_file_too_large / local_file_too_large are the file's fault; anything else is the host's.
        const tooLarge = err instanceof Error && /_file_too_large$/.test(err.message);
        throw new RepositoryRefUnreadableError(row.name, tooLarge ? "too_long" : "unavailable", {
          path: row.refFromFile,
        });
      }
      const parsed = parseRefFile(text);
      if (!parsed.ok) throw new RepositoryRefUnreadableError(row.name, parsed.reason, { path: row.refFromFile });
      ref = parsed.ref;
    }
    if (ref === null) throw new RepositoryRefUnreadableError(row.name, "invalid", {});
    let sha: string | null;
    try {
      sha = await deps.resolveRef({ repository: row.repository, ref, access: row.access });
    } catch {
      // An API failure or rate limit is the host's, not a bug: refuse the run instead of a 500.
      throw new RepositoryRefUnreadableError(
        row.name,
        "unavailable",
        row.refFromFile !== null ? { path: row.refFromFile } : {},
      );
    }
    if (sha === null || !COMMIT_SHA.test(sha)) {
      throw new RepositoryRefUnreadableError(
        row.name,
        "ref_not_found",
        row.refFromFile !== null ? { path: row.refFromFile } : { ref },
      );
    }
    resolved.push({ ...row, requestedRef: ref, resolvedSha: sha });
  }
  return resolved;
}
