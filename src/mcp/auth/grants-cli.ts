/**
 * `wardby grants migration-report [--json] | adopt-public --owner <subject>
 * [--dry-run] | prune-bindings [--dry-run]`: the operator's side of the
 * move from "owner-less = public" to explicit grants (resource-sharing
 * grants spec §3.7). Direct database access, like `auth host-account`.
 *
 * - migration-report is read-only and runs before AND after `migrate
 *   deploy`: it uses raw SQL over columns that exist in both, and predicts
 *   what the grants migration will do when its table isn't there yet.
 * - adopt-public gives every owner-less agent an owner (one Serializable
 *   transaction per agent), keeping its grants, keeping and reviving the new
 *   owner's own bindings, deleting the rest, and stamping the new owner's
 *   consent on attachments of its own tools. Other attachments stay inert
 *   and are printed with the attach_tool call that re-grants them.
 * - prune-bindings deletes the secret/datastore bindings on owned agents
 *   whose resource another principal owns (inert at run time since the
 *   grants release) and prints each one: the "removed and listed" record.
 */
import { parseArgs } from "node:util";
import { Prisma, type PrismaClient } from "#prisma";
import { canDelegate } from "../../core/grants.js";
import { resolvePrincipal } from "./principal.js";

const USAGE =
  "Use grants migration-report [--json] | grants adopt-public --owner <subject> [--dry-run] | grants prune-bindings [--dry-run].";

/** The report needs only raw queries, so it can run on a schema the generated client doesn't match. */
export interface ReportDb {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<T>;
}

type Caps = {
  allowedSecrets: unknown;
  allowedDatastorePrefixes: unknown;
  allowedHosts: unknown;
  allowedSharedDatastorePrefixes: unknown;
};

/** The attach_tool call (MCP) that re-grants an attachment's capabilities, for its owner to review and run. */
function regrantCall(agentId: string, toolId: string, caps: Caps): string {
  return `attach_tool ${JSON.stringify({
    agentId,
    toolId,
    allowedSecrets: caps.allowedSecrets,
    allowedDatastorePrefixes: caps.allowedDatastorePrefixes,
    allowedHosts: caps.allowedHosts,
    allowedSharedDatastorePrefixes: caps.allowedSharedDatastorePrefixes,
  })}`;
}

function hasCapabilities(caps: Caps): boolean {
  const nonEmpty = (v: unknown) =>
    Array.isArray(v) ? v.length > 0 : v !== null && typeof v === "object" && Object.keys(v).length > 0;
  return (
    nonEmpty(caps.allowedSecrets) ||
    nonEmpty(caps.allowedDatastorePrefixes) ||
    nonEmpty(caps.allowedHosts) ||
    nonEmpty(caps.allowedSharedDatastorePrefixes)
  );
}

export const BEHAVIOUR_CHANGES = [
  "Other principals can no longer edit a formerly public agent: update_agent, set/disable_schedule, delete_agent, attach/detach_tool, attach/detach_subagent, attach/detach_secret, attach/detach_datastore, datastore_set/delete, set/delete_agent_memory, create_webhook, unlink_repository.",
  "They can no longer read its data: get/list_agent_memory, datastore_get/list, or other principals' runs.",
  "They keep list_agents, get_agent (other owners' tool code hidden), list_subagents, list_repositories, list_tools, trigger_agent and the MCP prompts (everyone holds execute).",
  "Until adopt-public runs, a formerly public agent runs with no owned secrets or datastores and without its tools' capabilities.",
  "make_owner no longer accepts ownerId: null; non-owner coding task/baseRef needs the owner's allowWebhookTaskOverride.",
];

export interface MigrationReport {
  grantsTable: boolean;
  ownerlessAgents: { agentId: string; name: string; everyoneGrant: string | null }[];
  inertBindings: {
    kind: "secret" | "datastore";
    agentId: string;
    agentName: string;
    agentOwnerId: string | null;
    boundName: string;
    resourceId: string;
    resourceOwnerId: string | null;
    /** Removed by prune-bindings (owned agent); on an owner-less agent adopt-public decides. */
    prunable: boolean;
  }[];
  suspendedCapabilities: { agentId: string; agentName: string; toolId: string; toolName: string; regrant: string }[];
  failingEdges: {
    parentAgentId: string;
    parentOwnerId: string | null;
    childAgentId: string;
    childOwnerId: string | null;
    boundName: string;
  }[];
  webhooks: {
    onOwnerlessAgents: { id: string; agentId: string; createdBy: string | null }[];
    creatorLacksExecute: { id: string; agentId: string; createdBy: string | null }[];
  };
  behaviourChanges: string[];
  orphanGrants: { id: string; resourceType: string; resourceId: string }[] | null;
}

type BindingRow = Omit<MigrationReport["inertBindings"][number], "prunable">;
type CapsRow = Caps & { agentId: string; agentName: string; toolId: string; toolName: string };
type WebhookRow = { id: string; agentId: string; createdBy: string | null };

export async function migrationReport(db: ReportDb): Promise<MigrationReport> {
  const [{ present }] = await db.$queryRaw<{ present: boolean }[]>`
    SELECT to_regclass('"ResourceGrant"') IS NOT NULL AS "present"`;

  const ownerless = present
    ? await db.$queryRaw<{ agentId: string; name: string; everyoneGrant: string | null }[]>`
        SELECT a."id" AS "agentId", a."name",
          (SELECT g."level" FROM "ResourceGrant" g
            WHERE g."resourceType" = 'agent' AND g."resourceId" = a."id" AND g."granteeKey" = 'everyone') AS "everyoneGrant"
        FROM "Agent" a WHERE a."ownerId" IS NULL ORDER BY a."name"`
    : (
        await db.$queryRaw<{ agentId: string; name: string }[]>`
          SELECT a."id" AS "agentId", a."name" FROM "Agent" a WHERE a."ownerId" IS NULL ORDER BY a."name"`
      ).map((row) => ({ ...row, everyoneGrant: "execute (pending migration)" }));

  // A binding resolves only while the resource's owner is the agent's owner,
  // both non-null (core/secrets.ts, core/datastores.ts).
  const bindings = await db.$queryRaw<BindingRow[]>`
    SELECT 'secret' AS "kind", a."id" AS "agentId", a."name" AS "agentName", a."ownerId" AS "agentOwnerId",
      x."boundName", s."id" AS "resourceId", s."ownerId" AS "resourceOwnerId"
    FROM "AgentSecret" x JOIN "Secret" s ON s."id" = x."secretId" JOIN "Agent" a ON a."id" = x."agentId"
    WHERE a."ownerId" IS NULL OR s."ownerId" IS NULL OR s."ownerId" <> a."ownerId"
    UNION ALL
    SELECT 'datastore', a."id", a."name", a."ownerId", x."boundName", d."id", d."ownerId"
    FROM "AgentDatastore" x JOIN "Datastore" d ON d."id" = x."datastoreId" JOIN "Agent" a ON a."id" = x."agentId"
    WHERE a."ownerId" IS NULL OR d."ownerId" IS NULL OR d."ownerId" <> a."ownerId"
    ORDER BY "agentName", "boundName"`;

  const [{ stamped }] = await db.$queryRaw<{ stamped: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'AgentTool' AND column_name = 'capabilitiesGrantedById'
    ) AS "stamped"`;
  // After the migration: honoured only when stamped by the current owner.
  // Before it: what the migration will leave unstamped.
  const suspended = stamped
    ? await db.$queryRaw<CapsRow[]>`
        SELECT a."id" AS "agentId", a."name" AS "agentName", t."id" AS "toolId", t."name" AS "toolName",
          x."allowedSecrets", x."allowedDatastorePrefixes", x."allowedHosts", x."allowedSharedDatastorePrefixes"
        FROM "AgentTool" x JOIN "Agent" a ON a."id" = x."agentId" JOIN "Tool" t ON t."id" = x."toolId"
        WHERE a."ownerId" IS NULL OR x."capabilitiesGrantedById" IS DISTINCT FROM a."ownerId"
        ORDER BY a."name", t."name"`
    : await db.$queryRaw<CapsRow[]>`
        SELECT a."id" AS "agentId", a."name" AS "agentName", t."id" AS "toolId", t."name" AS "toolName",
          x."allowedSecrets", x."allowedDatastorePrefixes", x."allowedHosts", x."allowedSharedDatastorePrefixes"
        FROM "AgentTool" x JOIN "Agent" a ON a."id" = x."agentId" JOIN "Tool" t ON t."id" = x."toolId"
        WHERE a."ownerId" IS NULL OR (t."ownerId" IS NOT NULL AND t."ownerId" <> a."ownerId")
        ORDER BY a."name", t."name"`;

  // canDelegate: same owner (null = null), or the parent's owner holds
  // execute on the child. Before the migration, an owner-less child will
  // hold everyone-execute.
  const failingEdges = present
    ? await db.$queryRaw<MigrationReport["failingEdges"]>`
        SELECT e."parentAgentId", p."ownerId" AS "parentOwnerId", e."childAgentId", c."ownerId" AS "childOwnerId", e."boundName"
        FROM "AgentSubAgent" e JOIN "Agent" p ON p."id" = e."parentAgentId" JOIN "Agent" c ON c."id" = e."childAgentId"
        WHERE p."ownerId" IS DISTINCT FROM c."ownerId"
          AND NOT (p."ownerId" IS NOT NULL AND EXISTS (
            SELECT 1 FROM "ResourceGrant" g
            WHERE g."resourceType" = 'agent' AND g."resourceId" = c."id"
              AND g."granteeKey" IN ('principal:' || p."ownerId", 'everyone') AND g."level" IN ('execute', 'write')))
        ORDER BY e."boundName"`
    : await db.$queryRaw<MigrationReport["failingEdges"]>`
        SELECT e."parentAgentId", p."ownerId" AS "parentOwnerId", e."childAgentId", c."ownerId" AS "childOwnerId", e."boundName"
        FROM "AgentSubAgent" e JOIN "Agent" p ON p."id" = e."parentAgentId" JOIN "Agent" c ON c."id" = e."childAgentId"
        WHERE p."ownerId" IS DISTINCT FROM c."ownerId" AND NOT (p."ownerId" IS NOT NULL AND c."ownerId" IS NULL)
        ORDER BY e."boundName"`;

  const onOwnerlessAgents = await db.$queryRaw<WebhookRow[]>`
    SELECT w."id", w."agentId", w."ownerId" AS "createdBy"
    FROM "Webhook" w JOIN "Agent" a ON a."id" = w."agentId" WHERE a."ownerId" IS NULL ORDER BY w."id"`;
  // A webhook fires only while its creator owns the agent or holds execute.
  const creatorLacksExecute = present
    ? await db.$queryRaw<WebhookRow[]>`
        SELECT w."id", w."agentId", w."ownerId" AS "createdBy"
        FROM "Webhook" w JOIN "Agent" a ON a."id" = w."agentId"
        WHERE (a."ownerId" IS NULL OR w."ownerId" IS DISTINCT FROM a."ownerId")
          AND NOT EXISTS (
            SELECT 1 FROM "ResourceGrant" g
            WHERE g."resourceType" = 'agent' AND g."resourceId" = a."id"
              AND (g."granteeKey" = 'everyone' OR (w."ownerId" IS NOT NULL AND g."granteeKey" = 'principal:' || w."ownerId"))
              AND g."level" IN ('execute', 'write'))
        ORDER BY w."id"`
    : await db.$queryRaw<WebhookRow[]>`
        SELECT w."id", w."agentId", w."ownerId" AS "createdBy"
        FROM "Webhook" w JOIN "Agent" a ON a."id" = w."agentId"
        WHERE a."ownerId" IS NOT NULL AND w."ownerId" IS DISTINCT FROM a."ownerId"
        ORDER BY w."id"`;

  const orphanGrants = present
    ? await db.$queryRaw<{ id: string; resourceType: string; resourceId: string }[]>`
        SELECT g."id", g."resourceType", g."resourceId" FROM "ResourceGrant" g
        WHERE (g."resourceType" = 'agent' AND NOT EXISTS (SELECT 1 FROM "Agent" a WHERE a."id" = g."resourceId"))
           OR (g."resourceType" = 'tool' AND NOT EXISTS (SELECT 1 FROM "Tool" t WHERE t."id" = g."resourceId"))
           OR (g."resourceType" = 'budget_group'
               AND NOT EXISTS (SELECT 1 FROM "BudgetGroup" b WHERE b."id" = g."resourceId"))
           OR g."resourceType" NOT IN ('agent', 'tool', 'budget_group')
        ORDER BY g."id"`
    : null;

  return {
    grantsTable: present,
    ownerlessAgents: ownerless,
    inertBindings: bindings.map((b) => ({ ...b, prunable: b.agentOwnerId !== null })),
    suspendedCapabilities: suspended.filter(hasCapabilities).map((row) => ({
      agentId: row.agentId,
      agentName: row.agentName,
      toolId: row.toolId,
      toolName: row.toolName,
      regrant: regrantCall(row.agentId, row.toolId, row),
    })),
    failingEdges,
    webhooks: { onOwnerlessAgents, creatorLacksExecute },
    behaviourChanges: BEHAVIOUR_CHANGES,
    orphanGrants,
  };
}

export function formatMigrationReport(report: MigrationReport): string {
  const lines: string[] = [];
  const section = (title: string, rows: string[], empty = "none") => {
    lines.push("", `== ${title}`);
    lines.push(...(rows.length > 0 ? rows.map((r) => `  - ${r}`) : [`  ${empty}`]));
  };
  lines.push(
    report.grantsTable
      ? "Resource grants migration: applied."
      : "Resource grants migration: NOT applied yet (predicting its effect).",
  );
  section(
    "1. Owner-less agents (everyone grant)",
    report.ownerlessAgents.map((a) => `${a.name} (${a.agentId}): everyone ${a.everyoneGrant ?? "none"}`),
  );
  section(
    "2. Cross-owner secret/datastore bindings (inert at run time)",
    report.inertBindings.map(
      (b) =>
        `${b.kind} "${b.boundName}" on ${b.agentName} (${b.agentId}): resource ${b.resourceId} owned by ${b.resourceOwnerId ?? "nobody"}, agent owned by ${b.agentOwnerId ?? "nobody"}` +
        (b.prunable ? " -- removed by prune-bindings" : " -- decided by adopt-public"),
    ),
  );
  section(
    "3. Attachments whose capabilities are (or will be) suspended",
    report.suspendedCapabilities.map((c) => `${c.agentName} / ${c.toolName}: re-grant with ${c.regrant}`),
  );
  section(
    "4. Sub-agent edges refused at run time (canDelegate)",
    report.failingEdges.map(
      (e) =>
        `${e.parentAgentId} (owner ${e.parentOwnerId ?? "nobody"}) -> ${e.childAgentId} (owner ${e.childOwnerId ?? "nobody"}) as "${e.boundName}"`,
    ),
  );
  section(
    "5a. Webhooks on owner-less agents (fire through everyone-execute)",
    report.webhooks.onOwnerlessAgents.map((w) => `${w.id} on ${w.agentId}, created by ${w.createdBy ?? "unknown"}`),
  );
  section(
    "5b. Webhooks whose creator lacks execute (will not fire)",
    report.webhooks.creatorLacksExecute.map((w) => `${w.id} on ${w.agentId}, created by ${w.createdBy ?? "unknown"}`),
  );
  section("6. Behaviour changes for formerly public agents", [
    ...(report.ownerlessAgents.length > 0
      ? [`affected: ${report.ownerlessAgents.map((a) => a.name).join(", ")}`]
      : ["affected: none on this deployment"]),
    ...report.behaviourChanges,
  ]);
  section(
    "7. Orphan grants (resource gone)",
    report.orphanGrants === null ? [] : report.orphanGrants.map((g) => `${g.id}: ${g.resourceType} ${g.resourceId}`),
    report.orphanGrants === null ? "skipped: the ResourceGrant table does not exist yet" : "none",
  );
  return lines.join("\n").trimStart();
}

export interface AdoptedAgent {
  agentId: string;
  name: string;
  bindingsRemoved: { kind: "secret" | "datastore"; boundName: string; resourceId: string }[];
  bindingsKept: { kind: "secret" | "datastore"; boundName: string }[];
  capabilitiesStamped: string[];
  capabilitiesInert: { toolId: string; toolName: string; regrant: string }[];
  failingEdges: { parentAgentId: string; childAgentId: string; boundName: string }[];
}

export interface AdoptResult {
  owner: { id: string; subject: string };
  dryRun: boolean;
  agents: AdoptedAgent[];
}

class DryRunRollback extends Error {}

/** Gives every owner-less agent `ownerSubject` as its owner. See the module header. */
export async function adoptPublic(
  db: PrismaClient,
  opts: { ownerSubject: string; dryRun: boolean },
): Promise<AdoptResult> {
  // findUnique, never upsert: a typo must not mint a principal that then owns everything.
  const owner = await db.principal.findUnique({ where: { subject: opts.ownerSubject } });
  if (!owner) {
    throw new Error(`No principal with subject "${opts.ownerSubject}" (they must have signed in at least once).`);
  }
  const candidates = await db.agent.findMany({
    where: { ownerId: null },
    select: { id: true },
    orderBy: { name: "asc" },
  });
  const agents: AdoptedAgent[] = [];
  for (const { id } of candidates) {
    let adopted: AdoptedAgent | null = null;
    try {
      await db.$transaction(
        async (tx) => {
          const agent = await tx.agent.findUnique({ where: { id } });
          if (!agent || agent.ownerId !== null) return; // adopted concurrently
          await tx.agent.update({ where: { id }, data: { ownerId: owner.id } });

          const secrets = await tx.agentSecret.findMany({
            where: { agentId: id },
            include: { secret: { select: { ownerId: true } } },
            orderBy: { boundName: "asc" },
          });
          const datastores = await tx.agentDatastore.findMany({
            where: { agentId: id },
            include: { datastore: { select: { ownerId: true } } },
            orderBy: { boundName: "asc" },
          });
          const foreignSecrets = secrets.filter((b) => b.secret.ownerId !== owner.id);
          const foreignDatastores = datastores.filter((b) => b.datastore.ownerId !== owner.id);
          for (const b of foreignSecrets) {
            await tx.agentSecret.delete({ where: { agentId_secretId: { agentId: id, secretId: b.secretId } } });
          }
          for (const b of foreignDatastores) {
            await tx.agentDatastore.delete({
              where: { agentId_datastoreId: { agentId: id, datastoreId: b.datastoreId } },
            });
          }

          // Only the tool's owner could attach its private tool to a public
          // agent or change that attachment's capabilities, so those carry
          // the new owner's consent. Everything else stays inert.
          const attachments = await tx.agentTool.findMany({
            where: { agentId: id },
            include: { tool: { select: { id: true, name: true, ownerId: true } } },
            orderBy: { toolId: "asc" },
          });
          const own = attachments.filter((at) => at.tool.ownerId === owner.id);
          for (const at of own) {
            await tx.agentTool.update({
              where: { agentId_toolId: { agentId: id, toolId: at.toolId } },
              data: { capabilitiesGrantedById: owner.id },
            });
          }

          const edges = await tx.agentSubAgent.findMany({
            where: { OR: [{ parentAgentId: id }, { childAgentId: id }] },
            include: {
              parent: { select: { id: true, ownerId: true } },
              child: { select: { id: true, ownerId: true } },
            },
            orderBy: { boundName: "asc" },
          });
          const failingEdges: AdoptedAgent["failingEdges"] = [];
          for (const edge of edges) {
            if (!(await canDelegate(tx, edge.parent, edge.child))) {
              failingEdges.push({
                parentAgentId: edge.parentAgentId,
                childAgentId: edge.childAgentId,
                boundName: edge.boundName,
              });
            }
          }

          adopted = {
            agentId: id,
            name: agent.name,
            bindingsRemoved: [
              ...foreignSecrets.map((b) => ({
                kind: "secret" as const,
                boundName: b.boundName,
                resourceId: b.secretId,
              })),
              ...foreignDatastores.map((b) => ({
                kind: "datastore" as const,
                boundName: b.boundName,
                resourceId: b.datastoreId,
              })),
            ],
            bindingsKept: [
              ...secrets
                .filter((b) => b.secret.ownerId === owner.id)
                .map((b) => ({ kind: "secret" as const, boundName: b.boundName })),
              ...datastores
                .filter((b) => b.datastore.ownerId === owner.id)
                .map((b) => ({ kind: "datastore" as const, boundName: b.boundName })),
            ],
            capabilitiesStamped: own.map((at) => at.tool.name),
            capabilitiesInert: attachments
              .filter((at) => at.tool.ownerId !== owner.id && hasCapabilities(at))
              .map((at) => ({ toolId: at.toolId, toolName: at.tool.name, regrant: regrantCall(id, at.toolId, at) })),
            failingEdges,
          };
          if (opts.dryRun) throw new DryRunRollback();
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      if (!(err instanceof DryRunRollback)) throw err;
    }
    if (adopted) agents.push(adopted);
  }
  return { owner: { id: owner.id, subject: owner.subject }, dryRun: opts.dryRun, agents };
}

export function formatAdoptResult(result: AdoptResult): string {
  const lines = [
    `${result.dryRun ? "[dry run] would adopt" : "Adopted"} ${result.agents.length} owner-less agent(s) for ${result.owner.subject} (${result.owner.id}).`,
  ];
  for (const a of result.agents) {
    lines.push("", `${a.name} (${a.agentId}): owner ${result.owner.subject}; its grants are kept.`);
    for (const b of a.bindingsKept) lines.push(`  kept ${b.kind} binding "${b.boundName}"`);
    for (const b of a.bindingsRemoved) lines.push(`  removed ${b.kind} binding "${b.boundName}" (${b.resourceId})`);
    for (const t of a.capabilitiesStamped) lines.push(`  capabilities of own tool "${t}" now in force`);
    for (const t of a.capabilitiesInert)
      lines.push(`  capabilities of "${t.toolName}" stay inert; re-grant: ${t.regrant}`);
    for (const e of a.failingEdges) {
      lines.push(
        `  sub-agent edge ${e.parentAgentId} -> ${e.childAgentId} as "${e.boundName}" is refused at run time (not deleted)`,
      );
    }
  }
  return lines.join("\n");
}

export interface PruneResult {
  dryRun: boolean;
  removed: {
    kind: "secret" | "datastore";
    agentId: string;
    agentName: string;
    boundName: string;
    resourceId: string;
    resourceOwnerId: string | null;
  }[];
}

/** Deletes cross-owner secret/datastore bindings on owned agents, in one transaction. */
export async function pruneBindings(db: PrismaClient, opts: { dryRun: boolean }): Promise<PruneResult> {
  return db.$transaction(
    async (tx) => {
      const secrets = await tx.agentSecret.findMany({
        where: { agent: { ownerId: { not: null } } },
        include: { agent: { select: { name: true, ownerId: true } }, secret: { select: { ownerId: true } } },
        orderBy: [{ agentId: "asc" }, { boundName: "asc" }],
      });
      const datastores = await tx.agentDatastore.findMany({
        where: { agent: { ownerId: { not: null } } },
        include: { agent: { select: { name: true, ownerId: true } }, datastore: { select: { ownerId: true } } },
        orderBy: [{ agentId: "asc" }, { boundName: "asc" }],
      });
      const foreignSecrets = secrets.filter((b) => b.secret.ownerId !== b.agent.ownerId);
      const foreignDatastores = datastores.filter((b) => b.datastore.ownerId !== b.agent.ownerId);
      if (!opts.dryRun) {
        for (const b of foreignSecrets) {
          await tx.agentSecret.delete({ where: { agentId_secretId: { agentId: b.agentId, secretId: b.secretId } } });
        }
        for (const b of foreignDatastores) {
          await tx.agentDatastore.delete({
            where: { agentId_datastoreId: { agentId: b.agentId, datastoreId: b.datastoreId } },
          });
        }
      }
      return {
        dryRun: opts.dryRun,
        removed: [
          ...foreignSecrets.map((b) => ({
            kind: "secret" as const,
            agentId: b.agentId,
            agentName: b.agent.name,
            boundName: b.boundName,
            resourceId: b.secretId,
            resourceOwnerId: b.secret.ownerId,
          })),
          ...foreignDatastores.map((b) => ({
            kind: "datastore" as const,
            agentId: b.agentId,
            agentName: b.agent.name,
            boundName: b.boundName,
            resourceId: b.datastoreId,
            resourceOwnerId: b.datastore.ownerId,
          })),
        ],
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export function formatPruneResult(result: PruneResult): string {
  const verb = result.dryRun ? "would remove" : "removed";
  if (result.removed.length === 0) return `No cross-owner bindings to ${result.dryRun ? "remove" : "prune"}.`;
  return [
    `${result.dryRun ? "[dry run] " : ""}${result.removed.length} cross-owner binding(s):`,
    ...result.removed.map(
      (b) =>
        `  ${verb} ${b.kind} binding "${b.boundName}" on ${b.agentName} (${b.agentId}): ${b.resourceId} owned by ${b.resourceOwnerId ?? "nobody"}`,
    ),
  ].join("\n");
}

/**
 * The owner of an agent made with `wardby agent create` (resource-sharing
 * grants spec §3.8): `--owner <subject>` must already exist (a typo never
 * mints a principal), otherwise the local operator (LOCAL_PRINCIPAL),
 * found or created exactly as stdio does.
 */
export async function resolveCliAgentOwner(
  db: PrismaClient,
  ownerSubject: string | undefined,
  localPrincipal: string,
): Promise<string> {
  if (ownerSubject === undefined) return (await resolvePrincipal(localPrincipal, db)).id;
  const principal = await db.principal.findUnique({ where: { subject: ownerSubject } });
  if (!principal)
    throw new Error(`No principal with subject "${ownerSubject}" (they must have signed in at least once).`);
  return principal.id;
}

export async function grantsCommand(
  args: string[],
  db: PrismaClient,
  output: (value: string) => void = console.log,
): Promise<void> {
  const [action, ...rest] = args;
  if (action === "migration-report") {
    const { values } = parseArgs({ args: rest, strict: true, options: { json: { type: "boolean" } } });
    const report = await migrationReport(db);
    output(values.json ? JSON.stringify(report, null, 2) : formatMigrationReport(report));
    return;
  }
  if (action === "adopt-public") {
    const { values } = parseArgs({
      args: rest,
      strict: true,
      options: { owner: { type: "string" }, "dry-run": { type: "boolean" } },
    });
    if (!values.owner) throw new Error("grants adopt-public requires --owner <subject>.");
    output(
      formatAdoptResult(await adoptPublic(db, { ownerSubject: values.owner, dryRun: values["dry-run"] === true })),
    );
    return;
  }
  if (action === "prune-bindings") {
    const { values } = parseArgs({ args: rest, strict: true, options: { "dry-run": { type: "boolean" } } });
    output(formatPruneResult(await pruneBindings(db, { dryRun: values["dry-run"] === true })));
    return;
  }
  throw new Error(USAGE);
}
