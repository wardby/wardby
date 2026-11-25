import { normalizeHostedRepository } from "../../coding/code-host.js";
import { isSafeFilePath } from "../../coding/file-path.js";
import { normalizeGitRef } from "../../coding/protocol.js";
import { codingOverrideAllowed, type CodingOverrideAgent } from "../coding-override.js";
import { atLeast, effectiveAccess } from "../grants.js";
import type { PrismaClient } from "#prisma";
import { parseStoredDocumentTools } from "./tools-setting.js";

/** The longest repository path a document may be linked to. */
export const MAX_DOCUMENT_PATH_CHARS = 256;

/**
 * A document's repository file: a safe repository-relative path of plain
 * segments ending in `.md`, at most MAX_DOCUMENT_PATH_CHARS long. Throws
 * document_repo_link_invalid otherwise. The path is quoted into the run's
 * instructions, so it is kept to this narrow form.
 */
export function validDocumentPath(path: string): string {
  if (path.length > MAX_DOCUMENT_PATH_CHARS || !isSafeFilePath(path) || !path.toLowerCase().endsWith(".md")) {
    throw new Error("document_repo_link_invalid");
  }
  return path;
}

/** A design's repository directory: "." or safe relative segments, no trailing slash, at most 256 characters. */
export function validDesignDir(path: string): string {
  if (path === ".") return path;
  if (path.length > MAX_DOCUMENT_PATH_CHARS || path.endsWith("/") || !isSafeFilePath(path)) {
    throw new Error("document_repo_link_invalid");
  }
  return path;
}

/** A file inside a design directory. */
export const designFilePath = (dir: string, file: string): string => (dir === "." ? file : `${dir}/${file}`);

/** A hosted repository id (owner/name, or provider:workspace/repo), normalized; throws document_repo_link_invalid. */
export function validDocumentRepository(repository: string): string {
  try {
    return normalizeHostedRepository(repository);
  } catch {
    throw new Error("document_repo_link_invalid");
  }
}

/** A document's base ref, normalized as Git ref names are elsewhere; throws document_repo_link_invalid. */
export function validDocumentBaseRef(baseRef: string): string {
  try {
    return normalizeGitRef(baseRef);
  } catch {
    throw new Error("document_repo_link_invalid");
  }
}

/**
 * Sending to a coding agent hands it task text, a repository and a base ref
 * on the document owner's behalf: the same rule as trigger_agent
 * (core/coding-override.ts). Throws document_agent_unavailable unless
 * `principalId` owns the agent or the owner allows others' task text.
 */
export function assertDocumentAgentOverride(principalId: string, agent: CodingOverrideAgent): void {
  if (!codingOverrideAllowed(principalId, agent)) throw new Error("document_agent_unavailable");
}

/** What assertAgentRepository reads of an agent: its default repository and its linked repositories. */
export interface AgentRepositoryScope {
  codingProfile?: { repository: string; repositoryAuthorizedVia: string | null } | null;
  repositories?: { repository: string; authorizedVia: string | null }[];
}

/**
 * A document or design may be linked only to a repository the agent is already authorized for:
 * its codingProfile.repository (repositoryAuthorizedVia set; null is "never authorized"), or an authorized AgentRepository link (authorizedVia set; a null
 * one is "never authorized; use is refused"). `repository` is already canonical (hosted: lower-case
 * via validDocumentRepository; local: canonicalLocalRepository). Throws document_repo_link_invalid
 * with fixed text, never naming the repository.
 */
export function assertAgentRepository(agent: AgentRepositoryScope, repository: string): void {
  const allowed = [
    ...(agent.codingProfile && agent.codingProfile.repositoryAuthorizedVia !== null
      ? [agent.codingProfile.repository]
      : []),
    ...(agent.repositories ?? []).filter((r) => r.authorizedVia !== null).map((r) => r.repository),
  ];
  const same = (candidate: string): boolean => {
    if (candidate === repository) return true;
    if (repository.startsWith("local:") || candidate.startsWith("local:")) return false;
    try {
      return normalizeHostedRepository(candidate) === repository;
    } catch {
      return false;
    }
  };
  if (!allowed.some(same)) throw new Error("document_repo_link_invalid");
}

/** A plan set, as far as the link rule needs it. */
type PlanLinkSet = { store: string; agentId: string };

/**
 * The set a document is linked through when it belongs to a "wardby" plan set: such a document is
 * linked to the set's planner only, by its file in the plan folder (spec §5). Null otherwise.
 */
export function wardbyPlanLink<S extends PlanLinkSet>(doc: { planPath: string | null }, set: S | null): S | null {
  return set?.store === "wardby" && doc.planPath ? set : null;
}

/**
 * Whether a document's stored link lets it be sent to an agent: a "wardby" plan document linked to
 * its set's planner, or a repository-linked document (a design also needs its base ref). A document
 * removed from its plan never is. The send path (agent-loop.ts sendableLink) applies the same rule,
 * then checks the agent itself; the page uses this to offer "Send to agent".
 */
export function documentLinkSendable(
  doc: {
    kind: string;
    agentId: string | null;
    repository: string | null;
    path: string | null;
    baseRef: string | null;
    planPath: string | null;
    removedFromPlan: boolean;
  },
  set: PlanLinkSet | null,
): boolean {
  if (doc.removedFromPlan) return false;
  const plan = wardbyPlanLink(doc, set);
  if (plan) return doc.agentId === plan.agentId;
  return !!doc.repository && !!doc.path && (doc.kind !== "design" || !!doc.baseRef);
}

/** A native writer: the linker may execute it, and its documentTools allow write. Throws document_agent_unavailable. */
export async function assertNativeWriter(
  db: Pick<PrismaClient, "agent" | "resourceGrant">,
  linkerId: string,
  agentId: string,
): Promise<void> {
  const agent = await db.agent.findUnique({
    where: { id: agentId },
    select: { id: true, ownerId: true, kind: true, documentTools: true },
  });
  const setting = agent?.kind === "native" ? parseStoredDocumentTools(agent.documentTools) : null;
  if (!agent || setting?.access !== "write") throw new Error("document_agent_unavailable");
  if (!atLeast("agent", await effectiveAccess(db, "agent", agent, linkerId), "execute")) {
    throw new Error("document_agent_unavailable");
  }
}
