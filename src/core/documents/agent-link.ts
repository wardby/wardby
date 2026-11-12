import { normalizeHostedRepository } from "../../coding/code-host.js";
import { isSafeFilePath, normalizeGitRef } from "../../coding/protocol.js";
import { codingOverrideAllowed, type CodingOverrideAgent } from "../coding-override.js";

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
