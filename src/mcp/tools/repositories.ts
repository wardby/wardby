/**
 * AgentRepository CRUD — which repositories on which code-review host a
 * native agent may act on, and which host events trigger it. Linking needs
 * more than owning the agent: the owner's own linked GitHub account must have
 * the link's access on the repository (write for a write link, read for a
 * read link), or a wardby admin must approve it explicitly (adminOverride).
 * The authorization is stamped on the link and re-checked whenever the link
 * is used (core/repo-access.ts). A repository is an owner binding (resource-
 * sharing grants spec §3.4.3): link/unlink are the agent owner's alone (or
 * an admin's explicit approval), whatever grants others hold on the agent,
 * and owner-less agents can't be linked.
 * See docs/private/2026-09-26-repo-access-authorization-spec-and-plan.md.
 */
import { Prisma, type PrismaClient } from "#prisma";
import { isLocalRepository, normalizeGitHubRepository, normalizeLocalRepository } from "../../coding/protocol.js";
import { requireAgentAccess, requireBindable, requireBindingOwner } from "../auth/access.js";
import { authorizeRepositoryForSet, canonicalLocalRepository } from "../auth/repo-authorization.js";
import { requireScope } from "../auth/resource-server.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

const PROVIDERS = ["github", "local"] as const;
const TRIGGERS = ["pull_request", "mention", "push", "review_fix"] as const;
const CHECK_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._/()-]{0,99}$/;

type LinkArgs = {
  agentId: string;
  provider?: (typeof PROVIDERS)[number];
  repository: string;
  access: "read" | "write";
  triggers?: Array<(typeof TRIGGERS)[number]>;
  checkName?: string;
  reviewFixMaxRounds?: number;
  waitForCi?: boolean;
  markReadyWhenPassing?: boolean;
  adminOverride?: boolean;
};

function normalizeRepository(provider: string, repository: string): string {
  try {
    if (provider === "local") return normalizeLocalRepository(repository);
    if (provider === "github") return normalizeGitHubRepository(repository);
  } catch {
    // fall through
  }
  throw new McpError(400, `invalid repository "${repository}" for provider ${provider}`);
}

type LinkDb = Pick<PrismaClient, "agentRepository">;

async function assertNoConflicts(
  tx: LinkDb,
  args: Required<Pick<LinkArgs, "agentId" | "provider">> & {
    repository: string;
    triggers: string[];
    checkName: string | null;
  },
): Promise<void> {
  if (args.triggers.length === 0 && args.checkName === null) return;
  const others = await tx.agentRepository.findMany({
    where: { provider: args.provider, repository: args.repository, NOT: { agentId: args.agentId } },
  });
  if (args.triggers.includes("mention") && others.some((o) => o.triggers.includes("mention"))) {
    throw new McpError(409, `Another agent already handles @-mentions on ${args.repository}.`);
  }
  if (args.triggers.includes("review_fix") && others.some((o) => o.triggers.includes("review_fix"))) {
    throw new McpError(409, `Another agent already handles automatic review fixes on ${args.repository}.`);
  }
  // Against every other link, whatever its triggers: a check name identifies
  // one agent's verdict on the repository (also a unique index).
  if (args.checkName !== null && others.some((o) => o.checkName === args.checkName)) {
    throw checkNameTaken(args.checkName, args.repository);
  }
}

function checkNameTaken(checkName: string, repository: string): McpError {
  return new McpError(409, `Another agent already uses check name "${checkName}" on ${repository}.`);
}

export function registerRepositoryTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "link_repository",
    scope: "agents:write",
    description:
      "Links a native agent you own to a repository on a code-review host, with its access, event triggers, and checkName. " +
      "Triggers: pull_request (review each PR push), mention (answer @mentions), push (start on merges to the default branch), " +
      "review_fix (automatic review fix rounds). The review_fix trigger makes this agent the one wardby starts, automatically " +
      "and without a human comment, when wardby's own review check requests changes on a pull request a wardby coding run " +
      "opened (capped by reviewFixMaxRounds, default 2). " +
      "Your linked GitHub account (link_host_account) must have write access to the repository for a write link, or read for a " +
      "read link; a wardby admin may instead approve it with adminOverride. checkName is only allowed (and required) with the " +
      "pull_request trigger, and is unique per repository. waitForCi (only with the pull_request trigger) holds this agent's " +
      "review on a pushed head until that head's own CI finishes, instead of racing it; APPROVE is refused while CI on the " +
      "head is failing or still running. Re-linking an already-linked repository replaces its access, triggers, checkName, " +
      "reviewFixMaxRounds, waitForCi, and markReadyWhenPassing (an omitted field is cleared, not kept) and re-checks access " +
      "— always send the full desired state. A local repository (local:/abs/path, inside the server's trusted roots) takes " +
      "no triggers or checkName: it supports manual reviews only (trigger_agent with review).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentId: { type: "string" },
        provider: { type: "string", enum: [...PROVIDERS] },
        repository: { type: "string", minLength: 1, maxLength: 300 },
        access: { type: "string", enum: ["read", "write"] },
        triggers: { type: "array", items: { type: "string", enum: [...TRIGGERS] }, uniqueItems: true },
        checkName: { type: "string", minLength: 1, maxLength: 100 },
        reviewFixMaxRounds: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description:
            "Only with the review_fix trigger: automatic fix rounds per pull request before wardby stops (default 2).",
        },
        waitForCi: {
          type: "boolean",
          description:
            "Only with the pull_request trigger: hold this agent's review on a pushed head until that head's own CI " +
            "finishes, instead of racing it (default false).",
        },
        markReadyWhenPassing: {
          type: "boolean",
          description:
            "Only on a write link: mark the draft pull requests this agent, or a coding agent it delegated to " +
            "(directly or through sub-agents), opens here ready for review, once, " +
            "after every Wardby review check passed, CI is green and the wardby merge order check (if any) " +
            "is success (default false).",
        },
        adminOverride: {
          type: "boolean",
          description:
            "Admins only (agents:admin with the admin role): approve this link without checking GitHub access, recorded as an admin approval. Allowed on any agent that has an owner, not only the admin's own.",
        },
      },
      required: ["agentId", "repository", "access"],
    },
    handler: async (args: LinkArgs, ctx) => {
      // An admin approving a repository explicitly may do it on any agent
      // (the role already allows reassigning any agent with make_owner);
      // everyone else, admins included, links only agents they own.
      let agent;
      if (args.adminOverride === true) {
        requireScope(ctx, ctx.canonicalUri, "agents:admin");
        agent = await ctx.db.agent.findUnique({ where: { id: args.agentId } });
        if (!agent) throw new McpError(404, `Agent "${args.agentId}" not found.`);
      } else {
        agent = (await requireAgentAccess(ctx, args.agentId, "read")).agent;
        await requireBindable(ctx, agent);
      }
      if (agent.kind !== "native") {
        throw new McpError(
          400,
          "Repository links are for native agents only; coding agents use codingProfile.repository.",
        );
      }
      const provider = args.provider ?? (isLocalRepository(args.repository) ? "local" : "github");
      if ((provider === "local") !== isLocalRepository(args.repository)) {
        throw new McpError(400, `invalid repository "${args.repository}" for provider ${provider}`);
      }
      const repository =
        provider === "local"
          ? await canonicalLocalRepository(args.repository)
          : normalizeRepository(provider, args.repository);
      const triggers = [...new Set(args.triggers ?? [])];
      if (provider === "local") {
        if (triggers.length > 0) throw new McpError(400, "local repositories support manual review only");
        // A check is only published for a dispatched host PR; a local link has none.
        args = { ...args, checkName: undefined };
      }
      if (triggers.length > 0 && args.access !== "write") throw new McpError(400, "Event triggers need write access.");
      const checkName = args.checkName ?? null;
      if (triggers.includes("pull_request") && !checkName) {
        throw new McpError(400, "checkName is required with the pull_request trigger.");
      }
      if (checkName !== null && !triggers.includes("pull_request")) {
        throw new McpError(
          400,
          "checkName needs the pull_request trigger (a check is only published for a dispatched PR).",
        );
      }
      if (checkName !== null && !CHECK_NAME.test(checkName)) throw new McpError(400, "invalid checkName");
      const reviewFixMaxRounds = args.reviewFixMaxRounds ?? null;
      if (reviewFixMaxRounds !== null && !triggers.includes("review_fix")) {
        throw new McpError(400, "reviewFixMaxRounds needs the review_fix trigger.");
      }
      if (
        reviewFixMaxRounds !== null &&
        (!Number.isInteger(reviewFixMaxRounds) || reviewFixMaxRounds < 1 || reviewFixMaxRounds > 10)
      ) {
        throw new McpError(400, "reviewFixMaxRounds must be an integer from 1 to 10.");
      }
      const waitForCi = args.waitForCi ?? false;
      if (waitForCi && !triggers.includes("pull_request")) {
        throw new McpError(400, "waitForCi needs the pull_request trigger.");
      }
      const markReadyWhenPassing = args.markReadyWhenPassing ?? false;
      if (markReadyWhenPassing && args.access !== "write") {
        throw new McpError(400, "markReadyWhenPassing needs write access.");
      }

      // The host call happens before, and outside, the serializable transaction.
      const authorization = await authorizeRepositoryForSet(ctx, {
        ownerId: agent.ownerId,
        provider,
        repository,
        kind: args.access,
        adminOverride: args.adminOverride === true,
      });
      let link;
      try {
        link = await ctx.db.$transaction(
          async (tx) => {
            await assertNoConflicts(tx, { agentId: args.agentId, provider, repository, triggers, checkName });
            const fields = {
              access: args.access,
              triggers,
              checkName,
              reviewFixMaxRounds,
              waitForCi,
              markReadyWhenPassing,
              ...authorization,
            };
            return tx.agentRepository.upsert({
              where: { agentId_provider_repository: { agentId: args.agentId, provider, repository } },
              create: { agentId: args.agentId, provider, repository, ...fields },
              update: fields,
            });
          },
          { isolationLevel: "Serializable" },
        );
      } catch (err) {
        if (checkName !== null && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw checkNameTaken(checkName, repository);
        }
        throw err;
      }
      return textResult({ linked: true, link });
    },
  });

  mcp.registerTool({
    name: "unlink_repository",
    scope: "agents:write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentId: { type: "string" },
        provider: { type: "string", enum: [...PROVIDERS] },
        repository: { type: "string", minLength: 1, maxLength: 300 },
      },
      required: ["agentId", "repository"],
    },
    handler: async (args: { agentId: string; provider?: string; repository: string }, ctx) => {
      const { agent } = await requireAgentAccess(ctx, args.agentId, "read");
      requireBindingOwner(ctx, agent);
      const provider = args.provider ?? (isLocalRepository(args.repository) ? "local" : "github");
      let repository: string;
      if (provider === "local") {
        // The roots may have narrowed since linking; a link must stay removable.
        repository = await canonicalLocalRepository(args.repository).catch(() =>
          normalizeRepository(provider, args.repository),
        );
      } else repository = normalizeRepository(provider, args.repository);
      const { count } = await ctx.db.agentRepository.deleteMany({
        where: { agentId: args.agentId, provider, repository },
      });
      return textResult({ unlinked: count > 0 });
    },
  });

  mcp.registerTool({
    name: "list_repositories",
    scope: "agents:read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
    },
    handler: async (args: { agentId: string }, ctx) => {
      await requireAgentAccess(ctx, args.agentId, "read");
      const links = await ctx.db.agentRepository.findMany({
        where: { agentId: args.agentId },
        orderBy: { createdAt: "asc" },
      });
      return textResult({ repositories: links });
    },
  });
}
