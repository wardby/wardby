/**
 * Repository access authorization, host-neutral (security findings
 * H5-1/A3/C3-2 and H5-3). An agent may use a repository only when its current
 * owner's verified host identity has enough permission on it, or when the
 * authorization was an explicit, recorded admin approval (or predates
 * enforcement: "grandfathered"). Owner-less (public) agents never hold
 * repository authority: anyone can edit them.
 *
 * One gate serves every point of use (a coding run before its workspace is
 * prepared, each repo_* tool call, each host-event dispatch and mention
 * author) and every set-time check (link_repository, create/update_agent).
 * Host answers are cached per (provider, repository, host user id) for a
 * short TTL, positive and negative alike; set-time checks bypass the cache
 * and refresh it. A host error always denies: fail closed.
 * See docs/private/2026-09-26-repo-access-authorization-spec-and-plan.md.
 */
import type { PrismaClient } from "#prisma";
import {
  HOST_PERMISSION_RANK,
  type HostPermission,
  type HostUser,
  type ReviewHostProvider,
  type ReviewHostRegistry,
} from "../providers/review-host/types.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "repo-access" });

export type { HostPermission };

/** How an authorization was granted; stored on the row that grants the authority. */
export type AuthorizedVia = "host_permission" | "admin" | "grandfathered";
export const AUTHORIZED_VIA: readonly AuthorizedVia[] = ["host_permission", "admin", "grandfathered"];

export type RepoAccessDenial =
  "owner_required" | "not_authorized" | "identity_not_linked" | "insufficient_permission" | "check_failed";

export type RepoAccessDecision =
  { ok: true; level?: HostPermission } | { ok: false; reason: RepoAccessDenial; level?: HostPermission };

/** What a use of the repository needs. */
export type RepoAccessKind = "coding" | "write" | "read" | "mention";

/**
 * Coding runs and write links push, comment, and publish checks; a mention
 * drives a write-capable agent holding its owner's tools and secrets, so
 * triage is not enough for it either.
 */
export function requiredLevel(kind: RepoAccessKind): HostPermission {
  return kind === "read" ? "read" : "write";
}

export function atLeast(level: HostPermission, required: HostPermission): boolean {
  return HOST_PERMISSION_RANK[level] >= HOST_PERMISSION_RANK[required];
}

export interface AuthorizeUseInput {
  /** The agent's CURRENT owner — never whoever authorized the link. */
  ownerId: string | null;
  provider: string;
  repository: string;
  required: HostPermission;
  /** The stamp on the row granting the authority (null = never authorized). */
  authorizedVia: string | null;
}

export interface RepoAccessGate {
  /** Point of use: may this agent (by its owner and stamp) use the repository now? */
  authorizeUse(input: AuthorizeUseInput): Promise<RepoAccessDecision>;
  /** Does this principal's linked identity have `required` on the repository? */
  authorizePrincipal(input: {
    principalId: string;
    provider: string;
    repository: string;
    required: HostPermission;
    /** Bypass (and refresh) the cache: set-time checks. */
    fresh?: boolean;
  }): Promise<RepoAccessDecision>;
  /** Does this host user (e.g. a mention's author) have `required` on the repository? */
  authorizeHostUser(input: {
    provider: string;
    repository: string;
    user: HostUser;
    required: HostPermission;
    fresh?: boolean;
  }): Promise<RepoAccessDecision>;
}

export interface RepoAccessGateOptions {
  db: Pick<PrismaClient, "hostIdentity">;
  hosts: ReviewHostRegistry;
  /** Default 5 minutes. */
  ttlMs?: number;
  /** Default 1000; the oldest entry is evicted first. */
  maxEntries?: number;
  now?: () => number;
}

interface CacheEntry {
  level: HostPermission;
  expiresAt: number;
}

export const DEFAULT_REPO_ACCESS_TTL_MS = 5 * 60_000;

export function createRepoAccessGate(options: RepoAccessGateOptions): RepoAccessGate {
  const ttlMs = options.ttlMs ?? DEFAULT_REPO_ACCESS_TTL_MS;
  const maxEntries = options.maxEntries ?? 1000;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();

  /** The user's level, or null when it could not be determined (host missing or failing). */
  async function levelOf(
    provider: string,
    repository: string,
    user: HostUser,
    fresh: boolean,
  ): Promise<{ level: HostPermission; login: string } | null> {
    const key = `${provider}\u0000${repository}\u0000${user.id}`;
    const hit = cache.get(key);
    if (!fresh && hit && hit.expiresAt > now()) return { level: hit.level, login: user.login };
    const host = options.hosts[provider as ReviewHostProvider];
    if (!host) {
      log.warn({ provider, repository }, "no review host configured for a repository access check");
      return null;
    }
    let answer: { level: HostPermission; login: string };
    try {
      answer = await host.repositoryPermission(repository, user);
    } catch (err) {
      log.warn({ err, provider, repository, hostUserId: user.id }, "repository access check failed; denying");
      return null;
    }
    cache.delete(key);
    cache.set(key, { level: answer.level, expiresAt: now() + ttlMs });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
    return answer;
  }

  function decide(level: HostPermission, required: HostPermission): RepoAccessDecision {
    return atLeast(level, required) ? { ok: true, level } : { ok: false, reason: "insufficient_permission", level };
  }

  async function authorizePrincipal(input: {
    principalId: string;
    provider: string;
    repository: string;
    required: HostPermission;
    fresh?: boolean;
  }): Promise<RepoAccessDecision> {
    let identity;
    try {
      identity = await options.db.hostIdentity.findUnique({
        where: { principalId_provider: { principalId: input.principalId, provider: input.provider } },
      });
    } catch (err) {
      log.warn({ err, provider: input.provider }, "could not read a host identity; denying");
      return { ok: false, reason: "check_failed" };
    }
    if (!identity) return { ok: false, reason: "identity_not_linked" };
    const answer = await levelOf(
      input.provider,
      input.repository,
      { id: identity.hostUserId, login: identity.login },
      input.fresh === true,
    );
    if (!answer) return { ok: false, reason: "check_failed" };
    if (answer.login !== identity.login) {
      await options.db.hostIdentity
        .updateMany({
          where: { principalId: input.principalId, provider: input.provider, hostUserId: identity.hostUserId },
          data: { login: answer.login },
        })
        .catch((err: unknown) => log.warn({ err }, "could not record a renamed host login"));
    }
    return decide(answer.level, input.required);
  }

  return {
    async authorizeUse(input) {
      if (!input.ownerId) return { ok: false, reason: "owner_required" };
      if (input.authorizedVia === "admin" || input.authorizedVia === "grandfathered") return { ok: true };
      if (input.authorizedVia !== "host_permission") return { ok: false, reason: "not_authorized" };
      return authorizePrincipal({
        principalId: input.ownerId,
        provider: input.provider,
        repository: input.repository,
        required: input.required,
      });
    },
    authorizePrincipal,
    async authorizeHostUser(input) {
      const answer = await levelOf(input.provider, input.repository, input.user, input.fresh === true);
      if (!answer) return { ok: false, reason: "check_failed" };
      return decide(answer.level, input.required);
    },
  };
}

/** Actionable, non-leaking text for a denial, for tool results and run errors. */
export function describeDenial(decision: Extract<RepoAccessDecision, { ok: false }>, repository: string): string {
  switch (decision.reason) {
    case "owner_required":
      return `Agents without an owner cannot use repositories; an admin can assign one with make_owner.`;
    case "not_authorized":
      return `This agent's access to ${repository} was never authorized; re-link it (link_repository) or update the coding profile.`;
    case "identity_not_linked":
      return `The agent owner has not linked a GitHub account; run link_host_account first.`;
    case "insufficient_permission":
      return `The agent owner's GitHub account has ${decision.level ?? "no"} access to ${repository}, which is not enough.`;
    case "check_failed":
      return `Could not verify access to ${repository} right now; try again later.`;
  }
}
