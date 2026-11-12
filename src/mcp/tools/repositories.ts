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
import {
  CodingBaseRefSchema,
  CodingReadRefSchema,
  isCodingRepositoryName,
  isLocalRepository,
  normalizeGitHubRepository,
  normalizeLocalRepository,
} from "../../coding/protocol.js";
import { codeProviderOf, normalizeHostedRepository } from "../../coding/code-host.js";
import { isSafeRepoPath } from "../../coding/local-git.js";
import { defaultRepositoryName } from "../../coding/repository-names.js";
import { loadCodingRunRepositoryLimit } from "../../config/providers.js";
import {
  assertAgentAccess,
  requireAgentAccess,
  requireBindable,
  requireBindingOwner,
  requireNotPublicWritable,
} from "../auth/access.js";
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
  baseRef?: string;
  name?: string;
  ref?: string | { fromFile: string };
  inDefaultSet?: boolean;
  adminOverride?: boolean;
};

function normalizeRepository(provider: string, repository: string): string {
  try {
    if (provider === "local") return normalizeLocalRepository(repository);
    if (provider === "github") return normalizeGitHubRepository(repository);
    const normalized = normalizeHostedRepository(repository);
    if (codeProviderOf(normalized) === provider) return normalized;
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

function invalidName(): McpError {
  return new McpError(
    400,
    `repository_name_invalid: the link's name must match [a-z0-9][a-z0-9._-]{0,62} and not be "workspace"; pass name.`,
  );
}

function nameTaken(name: string, otherRepository: string): McpError {
  return new McpError(
    409,
    `repository_name_taken: the name "${name}" is already used by another link on this agent (${otherRepository}); pass a different name.`,
  );
}

function nameTakenRace(name: string): McpError {
  return new McpError(
    409,
    `repository_name_taken: the name "${name}" is already used by another link on this agent; pass a different name.`,
  );
}

function checkNameTaken(checkName: string, repository: string): McpError {
  return new McpError(409, `Another agent already uses check name "${checkName}" on ${repository}.`);
}

export function registerRepositoryTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "link_repository",
    scope: "agents:write",
    description:
      "Links an agent you own to a repository on a code-review host, with its access, event triggers, and checkName. " +
      "Triggers: pull_request (review each PR push), mention (answer @mentions), push (start on merges to the default branch), " +
      "review_fix (automatic review fix rounds). The review_fix trigger makes this agent the one wardby starts, automatically " +
      "and without a human comment, when wardby's own review check requests changes on a pull request a wardby coding run " +
      "opened (capped by reviewFixMaxRounds, default 2). " +
      "Your linked GitHub account (link_host_account) must have write access to the repository for a write link, or read for a " +
      "read link; a wardby admin may instead approve it with adminOverride. checkName is only allowed (and required) with the " +
      "pull_request trigger, and is unique per repository. waitForCi (only with the pull_request trigger) holds this agent's " +
      "review on a pushed head until that head's own CI finishes, instead of racing it; APPROVE is refused while CI on the " +
      "head is failing or still running. Re-linking an already-linked repository replaces its access, triggers, checkName, " +
      "reviewFixMaxRounds, waitForCi, markReadyWhenPassing, and baseRef (an omitted field is cleared, not kept) and re-checks access " +
      "— always send the full desired state. A local repository (local:/abs/path, inside the server's trusted roots) takes " +
      "no triggers or checkName: it supports manual reviews only (trigger_agent with review). " +
      "On a coding agent, adds a repository its runs may work in, with no triggers: a GitHub repository or a local one. " +
      'On a coding agent, access "read" adds a read-only repository mounted at /repos/<name> (needs ref: a branch, tag or commit SHA, ' +
      'or ref: { fromFile: "<path>" } read from the default repository at dispatch); write adds a writable one. ' +
      "name (default the repository's short name, lower-cased) is the folder under /repos/ and unique per agent; " +
      "inDefaultSet: true puts the link in the set every run gets unless trigger_agent, a webhook or a delegation names its own repositories list.",
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
        baseRef: {
          type: "string",
          description:
            "Coding agents only: the base branch for runs in this repository. Default: the coding profile's baseRef.",
        },
        name: { type: "string", minLength: 1, maxLength: 63 },
        ref: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              additionalProperties: false,
              properties: { fromFile: { type: "string", minLength: 1, maxLength: 255 } },
              required: ["fromFile"],
            },
          ],
        },
        inDefaultSet: { type: "boolean" },
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
        agent = await ctx.db.agent.findUnique({
          where: { id: args.agentId },
          include: { codingProfile: { select: { repository: true } } },
        });
        if (!agent) throw new McpError(404, `Agent "${args.agentId}" not found.`);
        await requireNotPublicWritable(agent, ctx.db);
      } else {
        const row = await ctx.db.agent.findUnique({
          where: { id: args.agentId },
          include: { codingProfile: { select: { repository: true } } },
        });
        agent = (await assertAgentAccess(ctx, row, args.agentId, "read")).agent;
        await requireBindable(ctx, agent);
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
      if (agent.kind === "coding") {
        // As codingProfile.repository: anything else would pass here and fail every run at dispatch.
        // What a coding run can work in, matching the coding profile.
        if (provider !== "github" && provider !== "local") {
          throw new McpError(400, "A coding agent's repository link must be a GitHub repository or a local: path.");
        }
        if (
          triggers.length > 0 ||
          args.checkName !== undefined ||
          args.reviewFixMaxRounds !== undefined ||
          args.waitForCi !== undefined ||
          args.markReadyWhenPassing !== undefined
        ) {
          throw new McpError(
            400,
            "A coding agent's repository link takes no triggers, checkName, reviewFixMaxRounds, waitForCi or markReadyWhenPassing.",
          );
        }
        if (args.access === "write" && agent.codingProfile?.repository === repository) {
          throw new McpError(400, `${repository} is already its default repository (codingProfile.repository).`);
        }
        if (args.access === "read") {
          if (args.baseRef !== undefined) throw new McpError(400, "A read link takes no baseRef.");
          if (args.ref === undefined) {
            throw new McpError(
              400,
              "A read link of a coding agent needs ref (a branch, tag or commit SHA) or ref: { fromFile }.",
            );
          }
        } else if (args.ref !== undefined) {
          throw new McpError(400, "ref applies only to a read link.");
        }
      } else if (
        args.baseRef !== undefined ||
        args.name !== undefined ||
        args.ref !== undefined ||
        args.inDefaultSet !== undefined
      ) {
        throw new McpError(
          400,
          args.baseRef !== undefined
            ? "baseRef applies only to a coding agent's repository link."
            : "name, ref and inDefaultSet apply only to a coding agent's repository link.",
        );
      }
      const parsedBaseRef = args.baseRef === undefined ? null : CodingBaseRefSchema.safeParse(args.baseRef);
      if (parsedBaseRef && !parsedBaseRef.success) throw new McpError(400, "baseRef must be a safe branch ref.");
      const baseRef = parsedBaseRef ? parsedBaseRef.data : null;
      const coding = agent.kind === "coding";
      if (coding && args.name !== undefined && !isCodingRepositoryName(args.name)) throw invalidName();
      let ref: string | null = null;
      let refFromFile: string | null = null;
      if (coding && args.ref !== undefined) {
        if (typeof args.ref === "string") {
          const parsed = CodingReadRefSchema.safeParse(args.ref);
          if (!parsed.success) throw new McpError(400, "ref must be a branch, a tag or a 40-hex commit SHA.");
          ref = parsed.data;
        } else {
          if (!isSafeRepoPath(args.ref.fromFile)) {
            throw new McpError(400, "ref.fromFile must be a repository-relative file path.");
          }
          refFromFile = args.ref.fromFile;
        }
      }
      const inDefaultSet = coding && args.inDefaultSet === true;
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
        kind: coding && args.access === "read" ? "coding_read" : args.access,
        adminOverride: args.adminOverride === true,
      });
      let link;
      try {
        link = await ctx.db.$transaction(
          async (tx) => {
            await assertNoConflicts(tx, { agentId: args.agentId, provider, repository, triggers, checkName });
            let name = `${provider}:${repository}`;
            if (coding) {
              let existingWrite: { name: string } | null = null;
              if (args.access === "write") {
                existingWrite = await tx.agentRepository.findFirst({
                  where: { agentId: args.agentId, provider, repository, access: "write" },
                  select: { name: true },
                });
              }
              // A write link keeps its name when re-linked without one (a backfilled name may not be the default).
              name = args.name ?? existingWrite?.name ?? defaultRepositoryName(repository);
              if (!isCodingRepositoryName(name)) throw invalidName();
              const named = await tx.agentRepository.findUnique({
                where: { agentId_name: { agentId: args.agentId, name } },
              });
              if (named && (named.provider !== provider || named.repository !== repository))
                throw nameTaken(name, named.repository);
              if (args.access === "write") {
                const otherWrite = await tx.agentRepository.findFirst({
                  where: { agentId: args.agentId, provider, repository, access: "write", NOT: { name } },
                  select: { name: true },
                });
                if (otherWrite) {
                  throw new McpError(
                    409,
                    `A coding agent can have one write link per repository; ${otherWrite.name} already is one.`,
                  );
                }
              }
              if (inDefaultSet) {
                const others = await tx.agentRepository.count({
                  where: { agentId: args.agentId, inDefaultSet: true, NOT: { name } },
                });
                const limit = loadCodingRunRepositoryLimit();
                if (others + 2 > limit) {
                  throw new McpError(
                    400,
                    `repository_set_too_large: the default set would hold ${others + 2} repositories (the default repository plus ${others + 1} links); the limit is ${limit} (CODING_MAX_RUN_REPOSITORIES).`,
                  );
                }
              }
            }
            const fields = {
              access: args.access,
              triggers,
              checkName,
              reviewFixMaxRounds,
              waitForCi,
              markReadyWhenPassing,
              baseRef,
              ref,
              refFromFile,
              inDefaultSet,
              ...authorization,
            };
            return tx.agentRepository.upsert({
              where: { agentId_name: { agentId: args.agentId, name } },
              create: { agentId: args.agentId, provider, repository, name, ...fields },
              update: fields,
            });
          },
          { isolationLevel: "Serializable" },
        );
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          if (JSON.stringify(err.meta?.target ?? "").includes("name")) {
            // A concurrent link took the name between the check and the write.
            throw nameTakenRace(args.name ?? defaultRepositoryName(repository));
          }
          if (checkName !== null) throw checkNameTaken(checkName, repository);
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
        name: { type: "string", minLength: 1, maxLength: 300 },
      },
      required: ["agentId", "repository"],
    },
    handler: async (args: { agentId: string; provider?: string; repository: string; name?: string }, ctx) => {
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
        where: { agentId: args.agentId, provider, repository, ...(args.name ? { name: args.name } : {}) },
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
