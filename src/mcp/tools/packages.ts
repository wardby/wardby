/**
 * approve_audited_packages: promotes what package audit mode recorded on a
 * run (docs/coding-packages.md#package-audit-mode) into the agent's package
 * allowlist, as bare names. Only `top-level` records are promoted by
 * default; an `unknown` one (a direct download, or after a plan fallback)
 * may really be a dependency of an allowlisted package, so it is promoted
 * only when `names` lists it. A `transitive` one follows its parent once that is allowlisted,
 * and an `allowed` one is already on the allowlist graph (it was recorded
 * only for the advisories full mode served past, which approving cannot
 * waive). For a parent run, each coding sub-run's names go to that sub-run's
 * own agent. Same gate as packageAllowlist: packages:approve or agents:admin,
 * and only the agent's owner. Every agent is checked before any is written,
 * and all are written in one transaction, so a refusal changes nothing.
 * Package audit mode itself is left as it is.
 */
import { Prisma } from "#prisma";
import { z } from "zod";
import { matchRoot, parseAllowlist, type PackageAllowlist } from "../../coding/registry/allowlist.js";
import { UNKNOWN_RELATION_LABEL } from "../../coding/registry/audit-mode.js";
import { REGISTRY_ADAPTERS } from "../../coding/registry/adapters.js";
import { logger } from "../../core/logger.js";
import { agentAccess } from "../auth/access.js";
import { requireAnyScope } from "../auth/resource-server.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

const packagesLog = logger.child({ module: "mcp-packages" });

/** codingProfile.packageAllowlist's own cap per ecosystem (coding/profile.ts). */
const MAX_ALLOWLIST_ENTRIES = 256;

const ApproveSchema = z
  .object({
    runId: z.string().trim().min(1).max(128),
    names: z.array(z.string().min(1).max(256)).min(1).max(MAX_ALLOWLIST_ENTRIES).optional(),
  })
  .strict();

export function registerPackageTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "approve_audited_packages",
    scope: "agents:write",
    description:
      "Add the packages a run installed under package audit mode to its agent's codingProfile.packageAllowlist, as " +
      "bare names (the top-level records in get_run's packageAudit; their dependencies then follow through the " +
      "allowlist graph). Records with relation unknown may be dependencies of allowlisted packages: they are added only " +
      "when `names` lists them, and are returned as `unknown` otherwise. For a parent run, each coding sub-run's " +
      "packages go to that sub-run's agent; nothing is changed unless every agent can be. `names` limits it to those " +
      "names. Needs packages:approve or agents:admin, and only the agent's owner may use it. Does not turn package " +
      "audit mode off.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string", description: "The run whose package audit to approve (get_run's packageAudit)." },
        names: {
          type: "array",
          items: { type: "string" },
          description:
            "Only these package names (as get_run lists them), including any with relation unknown to add; omitted means every top-level one.",
        },
      },
      required: ["runId"],
    },
    handler: async (raw: unknown, ctx) => {
      const parsed = ApproveSchema.safeParse(raw);
      if (!parsed.success) {
        const details = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
        throw new McpError(400, `Invalid approve_audited_packages arguments: ${details}`);
      }
      const { runId, names } = parsed.data;
      // The same gate as changing packageAllowlist through update_agent.
      requireAnyScope(ctx, ctx.canonicalUri, "packages:approve", "agents:admin");

      // Visible to the agent's owner and the run's triggerer only, exactly as get_run.
      const notFound = new McpError(404, `Run "${runId}" not found.`);
      const run = await ctx.db.run.findUnique({
        where: { id: runId },
        select: { id: true, agentId: true, triggeredById: true },
      });
      if (!run) throw notFound;
      if (run.triggeredById !== ctx.principal.id) {
        const agent = await ctx.db.agent.findUnique({ where: { id: run.agentId } });
        if (!agent || (await agentAccess(ctx, agent)) !== "owner") throw notFound;
      }

      // The coding runs whose records count, with the agent each one belongs to.
      const coding = await ctx.db.codingRun.findUnique({ where: { runId }, select: { runId: true } });
      const targets = coding
        ? [{ runId, agentId: run.agentId }]
        : (
            await ctx.db.run.findMany({
              where: { parentRunId: runId },
              select: { id: true, agentId: true, codingRun: { select: { runId: true } } },
            })
          )
            .filter((child) => child.codingRun)
            .map((child) => ({ runId: child.id, agentId: child.agentId }));
      const agentOf = new Map(targets.map((target) => [target.runId, target.agentId]));
      const records =
        targets.length > 0
          ? await ctx.db.registryAuditRecord.findMany({
              where: { runId: { in: targets.map((target) => target.runId) } },
              select: { runId: true, ecosystem: true, name: true, relation: true },
              orderBy: { createdAt: "asc" },
            })
          : [];
      const wanted = names ? new Set(names) : null;
      /** agentId -> ecosystem -> names to add, first-seen order. */
      const byAgent = new Map<string, Map<string, Set<string>>>();
      /** Unknown-relation names left out (not named), per ecosystem + name. */
      const skippedUnknown = new Map<string, { ecosystem: string; name: string }>();
      const topLevel = new Set(
        records.filter((r) => r.relation === "top-level").map((r) => `${r.runId}\0${r.ecosystem}\0${r.name}`),
      );
      for (const record of records) {
        if (record.relation !== "top-level" && record.relation !== "unknown") continue;
        if (wanted ? !wanted.has(record.name) : record.relation !== "top-level") {
          if (!wanted && !topLevel.has(`${record.runId}\0${record.ecosystem}\0${record.name}`))
            skippedUnknown.set(`${record.ecosystem}\0${record.name}`, {
              ecosystem: record.ecosystem,
              name: record.name,
            });
          continue;
        }
        const agentId = agentOf.get(record.runId)!;
        const ecosystems = byAgent.get(agentId) ?? new Map<string, Set<string>>();
        byAgent.set(agentId, ecosystems);
        ecosystems.set(record.ecosystem, (ecosystems.get(record.ecosystem) ?? new Set()).add(record.name));
      }

      type AgentResult = { agentId: string; added: Record<string, string[]>; packageAllowlist: PackageAllowlist };
      // One transaction: every agent is checked (owner, coding, the cap) before any is written.
      const results = await ctx.db.$transaction(
        async (tx) => {
          const planned: AgentResult[] = [];
          for (const [agentId, ecosystems] of byAgent) {
            const agent = await tx.agent.findUnique({ where: { id: agentId }, include: { codingProfile: true } });
            if (!agent?.codingProfile || agent.kind !== "coding") {
              throw new McpError(400, `Agent "${agentId}" is not a coding agent.`);
            }
            // Strict, like update_agent's coding profile: the owner only.
            if (agent.ownerId === null || agent.ownerId !== ctx.principal.id) {
              throw new McpError(403, `Agent "${agentId}": only its owner can change its package allowlist.`);
            }
            const current = (agent.codingProfile.packageAllowlist ?? {}) as PackageAllowlist;
            const parsedCurrent = parseAllowlist(current, REGISTRY_ADAPTERS);
            const next: Record<string, string[]> = Object.fromEntries(
              Object.entries(current).map(([ecosystem, entries]) => [ecosystem, [...entries]]),
            );
            const added: Record<string, string[]> = {};
            for (const [ecosystem, candidates] of ecosystems) {
              const adapter = REGISTRY_ADAPTERS.get(ecosystem);
              if (!adapter) continue;
              const entries = parsedCurrent.get(ecosystem) ?? [];
              const list = next[ecosystem] ?? [];
              for (const name of candidates) {
                // Already allowed (exactly, by a ranged entry, or a wildcard): an entry's range is the owner's.
                if (list.includes(name) || matchRoot(entries, adapter.normalizeName(name))) continue;
                list.push(name);
                (added[ecosystem] ??= []).push(name);
              }
              if (list.length > MAX_ALLOWLIST_ENTRIES) {
                throw new McpError(
                  400,
                  `Agent "${agentId}": approving these would put ${list.length} ${ecosystem} entries on its allowlist; the limit is ${MAX_ALLOWLIST_ENTRIES}. Approve fewer with \`names\`, or replace some entries with a scope wildcard. Nothing was changed.`,
                );
              }
              if (list.length > 0) next[ecosystem] = list;
            }
            // Every added name is a registry name the proxy normalized: still parsed, so the stored allowlist stays valid.
            parseAllowlist(next, REGISTRY_ADAPTERS);
            planned.push({ agentId, added, packageAllowlist: next });
          }
          for (const result of planned) {
            if (Object.keys(result.added).length === 0) continue;
            await tx.codingAgentProfile.update({
              where: { agentId: result.agentId },
              data: { packageAllowlist: result.packageAllowlist },
            });
          }
          return planned;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      for (const result of results) {
        const count = Object.values(result.added).reduce((sum, list) => sum + list.length, 0);
        if (count > 0) {
          packagesLog.info(
            {
              event: "coding.package_audit.promoted",
              agentId: result.agentId,
              runId,
              added: count,
              by: ctx.principal.id,
            },
            "audited packages added to the allowlist",
          );
        }
      }
      const unknown = [...skippedUnknown.values()];
      return textResult({
        runId,
        agents: results,
        ...(unknown.length > 0
          ? {
              unknown,
              unknownNote: `${UNKNOWN_RELATION_LABEL.toLowerCase()}. List one in \`names\` to add it.`,
            }
          : {}),
      });
    },
  });
}
