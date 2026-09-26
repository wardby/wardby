/**
 * Set-time repository authorization for the MCP tools that give an agent
 * authority over a repository (link_repository; create_agent/update_agent's
 * codingProfile.repository). Returns the stamp to store on the granting row,
 * or throws an actionable McpError. See core/repo-access.ts for the use-time
 * side and the rules; the host call happens here, before any transaction.
 */
import { requiredLevel, type AuthorizedVia, type RepoAccessKind } from "../../core/repo-access.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import { requireScope } from "./resource-server.js";

export interface RepositoryAuthorization {
  authorizedVia: AuthorizedVia;
  authorizedById: string;
  authorizedAt: Date;
}

export async function authorizeRepositoryForSet(
  ctx: McpRequestContext,
  input: {
    /** The agent's owner. The caller is always the owner here (or creating the agent). */
    ownerId: string | null;
    provider: string;
    repository: string;
    kind: RepoAccessKind;
    adminOverride?: boolean;
  },
): Promise<RepositoryAuthorization> {
  if (!input.ownerId) {
    throw new McpError(
      400,
      "owner_required: agents without an owner can't be given a repository, because an owner-less agent has no owner " +
        "whose GitHub access can be checked. An admin can assign an owner with make_owner first.",
    );
  }
  const stamp = (authorizedVia: AuthorizedVia): RepositoryAuthorization => ({
    authorizedVia,
    authorizedById: ctx.principal.id,
    authorizedAt: new Date(),
  });
  if (input.adminOverride) {
    // Role-gated: the scope alone never suffices (resource-server.ts).
    requireScope(ctx, ctx.canonicalUri, "agents:admin");
    return stamp("admin");
  }
  const gate = ctx.providers.repoAccess;
  if (!gate) {
    throw new McpError(
      503,
      "Repository access can't be checked on this deployment (no GitHub App is configured). " +
        "An admin can approve it explicitly with adminOverride.",
    );
  }
  const required = requiredLevel(input.kind);
  const decision = await gate.authorizePrincipal({
    principalId: input.ownerId,
    provider: input.provider,
    repository: input.repository,
    required,
    fresh: true,
  });
  if (decision.ok) return stamp("host_permission");
  switch (decision.reason) {
    case "identity_not_linked":
      throw new McpError(
        403,
        "Link your GitHub account first (link_host_account): wardby checks that your own GitHub account can " +
          `access ${input.repository} before an agent you own may use it.`,
      );
    case "insufficient_permission":
      throw new McpError(
        403,
        `Your linked GitHub account has ${decision.level ?? "no"} access to ${input.repository}; ` +
          `this needs ${required}. Ask a repository admin for access, or a wardby admin to approve it (adminOverride).`,
      );
    default:
      throw new McpError(
        503,
        `Could not verify your GitHub access to ${input.repository} right now (is the GitHub App installed on it?). Try again.`,
      );
  }
}
