/**
 * AgentRepository CRUD — which repositories on which code-review host a
 * native agent may act on, and which host events trigger it. Same rule as a
 * coding agent's `repository`: agents:write, any repository the App is
 * installed on. See docs/private/2026-09-25-code-review-host-design.md §8.
 */
import type { PrismaClient } from "#prisma";
import { normalizeGitHubRepository } from "../../coding/protocol.js";
import { requireOwnedAgent, requireReadableAgent } from "../auth/ownership.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

const PROVIDERS = ["github"] as const;
const TRIGGERS = ["pull_request", "mention"] as const;
const CHECK_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._/()-]{0,99}$/;

type LinkArgs = {
  agentId: string;
  provider?: (typeof PROVIDERS)[number];
  repository: string;
  access: "read" | "write";
  triggers?: Array<(typeof TRIGGERS)[number]>;
  checkName?: string;
};

function normalizeRepository(provider: string, repository: string): string {
  try {
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
  if (args.triggers.length === 0) return;
  const others = await tx.agentRepository.findMany({
    where: { provider: args.provider, repository: args.repository, NOT: { agentId: args.agentId } },
  });
  if (args.triggers.includes("mention") && others.some((o) => o.triggers.includes("mention"))) {
    throw new McpError(409, `Another agent already handles @-mentions on ${args.repository}.`);
  }
  if (
    args.triggers.includes("pull_request") &&
    others.some((o) => o.triggers.includes("pull_request") && o.checkName === args.checkName)
  ) {
    throw new McpError(409, `Another agent already uses check name "${args.checkName}" on ${args.repository}.`);
  }
}

export function registerRepositoryTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "link_repository",
    scope: "agents:write",
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
      },
      required: ["agentId", "repository", "access"],
    },
    handler: async (args: LinkArgs, ctx) => {
      const agent = await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      if (agent.kind !== "native") {
        throw new McpError(
          400,
          "Repository links are for native agents only; coding agents use codingProfile.repository.",
        );
      }
      const provider = args.provider ?? "github";
      const repository = normalizeRepository(provider, args.repository);
      const triggers = [...new Set(args.triggers ?? [])];
      if (triggers.length > 0 && args.access !== "write") throw new McpError(400, "Event triggers need write access.");
      const checkName = args.checkName ?? null;
      if (triggers.includes("pull_request") && !checkName) {
        throw new McpError(400, "checkName is required with the pull_request trigger.");
      }
      if (checkName !== null && !CHECK_NAME.test(checkName)) throw new McpError(400, "invalid checkName");

      const link = await ctx.db.$transaction(
        async (tx) => {
          await assertNoConflicts(tx, { agentId: args.agentId, provider, repository, triggers, checkName });
          return tx.agentRepository.upsert({
            where: { agentId_provider_repository: { agentId: args.agentId, provider, repository } },
            create: { agentId: args.agentId, provider, repository, access: args.access, triggers, checkName },
            update: { access: args.access, triggers, checkName },
          });
        },
        { isolationLevel: "Serializable" },
      );
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
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      const provider = args.provider ?? "github";
      const repository = normalizeRepository(provider, args.repository);
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
      await requireReadableAgent(ctx.db, args.agentId, ctx.principal.id);
      const links = await ctx.db.agentRepository.findMany({
        where: { agentId: args.agentId },
        orderBy: { createdAt: "asc" },
      });
      return textResult({ repositories: links });
    },
  });
}
