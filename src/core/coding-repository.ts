/**
 * Which repository a coding run works in: the agent's default
 * (codingProfile.repository) or one of its write links without triggers.
 * Every entry point goes through here. Errors never carry the requested value:
 * it is caller- or model-written text and could hold a secret.
 */
import type { Prisma } from "#prisma";
import { codeProviderOf, normalizeHostedRepository } from "../coding/code-host.js";
import { isLocalRepository, normalizeGitHubRepository, normalizeLocalRepository } from "../coding/protocol.js";

export type CodingRepositoryReader = Pick<Prisma.TransactionClient, "agentRepository" | "codingRun">;

export interface CodingRepositoryTarget {
  repository: string;
  baseRef: string;
  viaRepositoryLink: boolean;
}

export type RepositoryRefusalCode = "repository_required" | "repository_not_listed";

export class RepositoryChoiceRefusedError extends Error {
  constructor(
    readonly code: RepositoryRefusalCode,
    readonly allowed: readonly string[],
  ) {
    super(
      code === "repository_required"
        ? `This coding agent works in several repositories: pass repository, one of ${allowed.join(", ")}.`
        : `That repository is not on this coding agent's list: ${allowed.join(", ")}.`,
    );
    this.name = "RepositoryChoiceRefusedError";
  }
}

function canonical(value: string): string | null {
  try {
    if (isLocalRepository(value)) return normalizeLocalRepository(value);
    if (codeProviderOf(value) === "github") return normalizeGitHubRepository(value);
    return normalizeHostedRepository(value);
  } catch {
    return null;
  }
}

function same(a: string, b: string): boolean {
  const left = canonical(a);
  return left !== null && left === canonical(b);
}

/** Which of an agent's links are repositories on a coding agent's list. */
export const CODING_REPOSITORY_LINK_FILTER = { access: "write", triggers: { isEmpty: true } } as const;

/**
 * The repositories a list adds to its default. A link can come to equal the default when
 * update_agent moves the default onto it; that link adds nothing, and a run there is on the default.
 */
export function extraCodingRepositoryLinks<Link extends { repository: string }>(
  links: readonly Link[],
  defaultRepository: string,
): Link[] {
  return links.filter((link) => !same(link.repository, defaultRepository));
}

async function listExtraRepositoryLinks(
  reader: Pick<CodingRepositoryReader, "agentRepository">,
  agentId: string,
  defaultRepository: string,
) {
  const links = await reader.agentRepository.findMany({
    where: { agentId, ...CODING_REPOSITORY_LINK_FILTER },
    select: { repository: true, baseRef: true },
    orderBy: { repository: "asc" },
  });
  return extraCodingRepositoryLinks(links, defaultRepository);
}

/** Whether the agent has more than its default, for wording only: authorization is resolveCodingRepository's. */
export async function hasCodingRepositoryList(
  reader: Pick<CodingRepositoryReader, "agentRepository">,
  agentId: string,
  defaultRepository: string,
): Promise<boolean> {
  return (await listExtraRepositoryLinks(reader, agentId, defaultRepository)).length > 0;
}

export async function resolveCodingRepository(
  reader: CodingRepositoryReader,
  input: {
    agentId: string;
    profile: { repository: string; baseRef: string };
    requested?: string;
    continuesCodingRunId?: string;
    /** A delegation must name its repository when the agent has more than its default. */
    requireExplicit?: boolean;
  },
): Promise<CodingRepositoryTarget> {
  const { profile, requested, continuesCodingRunId } = input;
  const defaultTarget = { repository: profile.repository, baseRef: profile.baseRef, viaRepositoryLink: false };
  if (requested !== undefined && same(requested, profile.repository)) return defaultTarget;
  if (requested === undefined && continuesCodingRunId === undefined && !input.requireExplicit) return defaultTarget;

  const links = await listExtraRepositoryLinks(reader, input.agentId, profile.repository);
  const onList = (name: string) => links.find((link) => same(link.repository, name));
  const target = (link: { repository: string; baseRef: string | null }) => ({
    repository: link.repository,
    baseRef: link.baseRef ?? profile.baseRef,
    viaRepositoryLink: true,
  });
  const allowed = [profile.repository, ...links.map((link) => link.repository)];

  if (requested !== undefined) {
    const link = onList(requested);
    if (!link) throw new RepositoryChoiceRefusedError("repository_not_listed", allowed);
    return target(link);
  }
  if (continuesCodingRunId !== undefined) {
    const repository = await continuationRepository(reader, continuesCodingRunId);
    const link = repository === null ? undefined : onList(repository);
    // Anything else stays on the default, where checkContinuation gives its own refusal.
    return link ? target(link) : defaultTarget;
  }
  if (links.length > 0) throw new RepositoryChoiceRefusedError("repository_required", allowed);
  return defaultTarget;
}

async function continuationRepository(reader: Pick<CodingRepositoryReader, "codingRun">, runId: string) {
  const select = { repository: true, rootCodingRunId: true } as const;
  const run = await reader.codingRun.findUnique({ where: { runId }, select });
  if (!run) return null;
  if (!run.rootCodingRunId) return run.repository;
  const root = await reader.codingRun.findUnique({ where: { runId: run.rootCodingRunId }, select });
  return root?.repository ?? null;
}
