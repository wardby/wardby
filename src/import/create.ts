/**
 * Ordered idempotent create step — writes Tier-1 entities (tools, agents,
 * attachments, secrets, datastores, webhooks, budget groups) to the database
 * from a validated bundle + reconciliation.
 */

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { KeyObject } from "node:crypto";
import type { Bundle } from "./bundle.js";
import type { Reconciliation } from "./preflight.js";
import type { SecretCipher } from "../providers/secrets/types.js";
import { createSecret, attachSecret } from "../core/secrets.js";
import { createDatastore, attachDatastore } from "../core/datastores.js";
import { createWebhook } from "../core/webhooks.js";
import { deriveJsonSchema } from "../sandbox/zod-params.js";
import { ToolCapabilitiesPatchSchema, FETCH_WILDCARD } from "../sandbox/tool-capabilities.js";
import { PostgresDatastore } from "../providers/datastore/postgres.js";
import type { DatastoreValue } from "../providers/datastore/types.js";
import { decryptTransferEnvelope } from "../providers/secrets/transfer-envelope.js";
import { mapBudget } from "./budgets.js";

export interface CreateOptions {
  db: PrismaClient;
  cipher: SecretCipher;
  ownerId: string | null;
  defaultBudget: string;
  secretMode: "references" | "envelope";
  transferPrivateKey?: KeyObject;
  allowOpenFetch: boolean;
}

export interface ImportResult {
  agentsCreated: number;
  toolsCreated: number;
  secretsCreated: number;
  datastoreEntries: number;
  datastoresSharedCreated: number;
  budgetGroupsCreated: number;
  webhookSecrets: { agentName: string; secret: string }[];
  pendingSecretReentry: string[];
  warnings: string[];
}

export async function createFromBundle(
  bundle: Bundle,
  recon: Reconciliation,
  opts: CreateOptions,
): Promise<ImportResult> {
  const { db, cipher, ownerId, secretMode, transferPrivateKey, allowOpenFetch } = opts;
  const warnings: string[] = [];
  const webhookSecrets: { agentName: string; secret: string }[] = [];
  const pendingSecretReentry: string[] = [];
  const hasOwner = ownerId !== null;

  // Helper: apply nameRemap
  const eff = (name: string) => recon.nameRemap.get(name) ?? name;

  // Helper: check if agent/tool was skipped/rejected
  const agentSkipped = (name: string) => recon.agents.find((a) => a.name === name)?.skipped;
  const agentDisabled = (name: string) => recon.agents.find((a) => a.name === name)?.disabled ?? false;
  const toolRejected = (name: string) => recon.tools.find((t) => t.name === name)?.rejected;
  const toolSkipped = (name: string) => recon.tools.find((t) => t.name === name)?.skipped;

  // Track created entities
  let toolsCreated = 0;
  let agentsCreated = 0;
  let secretsCreated = 0;
  let datastoreEntries = 0;
  let datastoresSharedCreated = 0;
  let budgetGroupsCreated = 0;

  // Step 1: Tools
  const toolIdMap = new Map<string, string>();
  for (const t of bundle.readTools()) {
    if (toolRejected(t.name) || toolSkipped(t.name)) continue;

    const schema = await deriveJsonSchema(t.paramsZod);
    if (!schema.ok) {
      warnings.push(`tool ${t.name}: failed to derive JSON schema, skipping`);
      continue;
    }

    const tool = await db.tool.upsert({
      where: { name: eff(t.name) },
      create: {
        name: eff(t.name),
        description: t.description,
        paramsZod: t.paramsZod,
        code: t.code,
        jsonSchema: schema.value as object,
        ownerId,
      },
      update: {},
    });
    toolIdMap.set(t.name, tool.id);
    toolsCreated++;
  }

  // Step 2: Agents
  const agentIdMap = new Map<string, string>();
  for (const a of bundle.readAgents()) {
    if (agentSkipped(a.name)) continue;

    const scheduleEnabled = agentDisabled(a.name) ? false : a.scheduleEnabled;
    const agent = await db.agent.upsert({
      where: { name: eff(a.name) },
      create: {
        name: eff(a.name),
        model: a.model,
        systemPrompt: a.systemPrompt,
        budgetUsd: opts.defaultBudget,
        schedule: a.schedule || null,
        timezone: a.timezone,
        maxTurns: a.maxTurns,
        scheduleEnabled,
        ownerId,
      },
      update: {},
    });
    agentIdMap.set(a.name, agent.id);
    agentsCreated++;
  }

  // Step 3: Attach tools
  for (const at of bundle.readAgentTools()) {
    const agentId = agentIdMap.get(at.agentName);
    const toolId = toolIdMap.get(at.toolName);
    if (!agentId || !toolId) {
      const missing = !agentId ? `agent ${at.agentName}` : `tool ${at.toolName}`;
      warnings.push(`agent-tool ${at.agentName}/${at.toolName}: skipped — ${missing} was not imported`);
      continue;
    }

    // Validate capabilities (drop "*" unless allowOpenFetch)
    let allowedHosts = at.allowedHosts;
    if (!allowOpenFetch) {
      allowedHosts = allowedHosts.filter((h) => h !== FETCH_WILDCARD);
    }

    const capsPatch = ToolCapabilitiesPatchSchema.safeParse({
      allowedSecrets: at.allowedSecrets,
      allowedDatastorePrefixes: at.allowedDatastorePrefixes,
      allowedHosts,
      allowedSharedDatastorePrefixes: at.allowedSharedDatastorePrefixes,
    });

    if (!capsPatch.success) {
      warnings.push(`agent-tool ${at.agentName}/${at.toolName}: invalid capabilities, skipping attachment`);
      continue;
    }

    const caps = capsPatch.data;
    await db.agentTool.upsert({
      where: { agentId_toolId: { agentId, toolId } },
      create: {
        agentId,
        toolId,
        allowedSecrets: caps.allowedSecrets ?? [],
        allowedDatastorePrefixes: caps.allowedDatastorePrefixes ?? [],
        allowedHosts: caps.allowedHosts ?? [],
        allowedSharedDatastorePrefixes: caps.allowedSharedDatastorePrefixes ?? {},
      },
      update: {
        allowedSecrets: caps.allowedSecrets ?? [],
        allowedDatastorePrefixes: caps.allowedDatastorePrefixes ?? [],
        allowedHosts: caps.allowedHosts ?? [],
        allowedSharedDatastorePrefixes: caps.allowedSharedDatastorePrefixes ?? {},
      },
    });
  }

  // Step 4: Secrets — one row per base secret, under its canonical name.
  if (secretMode === "envelope") {
    if (!hasOwner) {
      for (const s of bundle.readSecrets()) {
        warnings.push(`secret ${s.name}: skipped — secrets require an owner (public import)`);
      }
    } else if (!transferPrivateKey) {
      warnings.push("envelope mode requires transferPrivateKey, skipping secrets");
    } else {
      const owner = ownerId; // hasOwner guarantees non-null
      for (const s of bundle.readSecrets()) {
        if (!s.ciphertext) {
          warnings.push(`secret ${s.name}: no ciphertext in envelope mode, skipping`);
          continue;
        }
        let plaintext: string;
        try {
          // AAD is ALWAYS the base secret name (s.name), never an alias.
          plaintext = decryptTransferEnvelope(s.ciphertext, s.name, transferPrivateKey);
        } catch (err) {
          warnings.push(`secret ${s.name}: failed to decrypt (${err instanceof Error ? err.message : String(err)})`);
          continue;
        }
        try {
          await createSecret(s.name, plaintext, owner, cipher, db);
          secretsCreated++; // one per distinct base secret (fixes F1 over-count)
        } catch (err) {
          warnings.push(`secret ${s.name}: failed to create (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }
  } else {
    for (const s of bundle.readSecrets()) {
      pendingSecretReentry.push(s.name);
    }
  }

  // Step 5: Attach secrets (envelope mode only)
  if (secretMode === "envelope" && hasOwner) {
    const owner = ownerId;
    for (const as of bundle.readAgentSecrets()) {
      const agentId = agentIdMap.get(as.agentName);
      if (!agentId) continue;
      const boundName = as.alias ?? as.secretName;
      try {
        await attachSecret(agentId, as.secretName, owner, db, boundName);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          // Either an idempotent re-run, or two secrets bound to the same
          // point-of-use name for one agent (a bundle inconsistency). Surface it.
          warnings.push(
            `agent-secret ${as.agentName}: "${boundName}" already bound — skipped (re-run or duplicate binding)`,
          );
          continue;
        }
        warnings.push(
          `agent-secret ${as.agentName}/${as.secretName}: failed to attach (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }

  // Step 6: Per-agent datastore seed
  const ds = new PostgresDatastore(db, cipher);
  for (const d of bundle.readSingleDatastores()) {
    const agentId = agentIdMap.get(d.agentName);
    if (!agentId) continue;

    for (const entry of d.entries) {
      try {
        await ds.set(agentId, entry.key, entry.value as DatastoreValue, { pii: entry.pii });
        datastoreEntries++;
      } catch (err) {
        warnings.push(
          `datastore ${d.agentName}/${entry.key}: failed to set (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }

  // Step 6.5: Shared datastores — require an owner, same rule as
  // secrets/webhooks/budgets: skip with a warning in public-import mode.
  if (!hasOwner) {
    for (const sd of bundle.readSharedDatastores()) {
      warnings.push(`shared-datastore ${sd.name}: skipped — shared datastores require an owner (public import)`);
    }
  } else {
    const owner = ownerId; // hasOwner guarantees non-null
    for (const sd of bundle.readSharedDatastores()) {
      let created: Awaited<ReturnType<typeof createDatastore>>;
      try {
        created = await createDatastore(sd.name, owner, db);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          // Two shared-datastore definitions in this bundle collide on
          // (ownerId, name) — createDatastore isn't idempotent (Task 3).
          // Surface it and move on rather than aborting the whole import.
          warnings.push(
            `shared-datastore ${sd.name}: a datastore with this name already exists for this owner — skipped`,
          );
          continue;
        }
        warnings.push(
          `shared-datastore ${sd.name}: failed to create (${err instanceof Error ? err.message : String(err)})`,
        );
        continue;
      }
      datastoresSharedCreated++;

      for (const entry of sd.entries) {
        try {
          await db.datastoreEntry.create({
            data: { datastoreId: created.id, key: entry.key, value: entry.value as Prisma.InputJsonValue, pii: false },
          });
        } catch (err) {
          warnings.push(
            `shared-datastore ${sd.name}/${entry.key}: failed to seed (${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }

      for (const agentName of sd.attachedAgentNames) {
        const agentId = agentIdMap.get(agentName);
        if (!agentId) continue;
        try {
          await attachDatastore(agentId, created.id, db, sd.name);
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            warnings.push(`shared-datastore ${sd.name}: agent ${agentName} already binds "${sd.name}" — skipped`);
            continue;
          }
          warnings.push(
            `shared-datastore ${sd.name}/${agentName}: failed to attach (${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
    }
  }

  // Step 7: Webhooks
  if (!hasOwner) {
    // Webhooks require an owner - skip in public import mode
    for (const w of bundle.readWebhooks()) {
      warnings.push(`webhook for agent ${w.agentName}: skipped — webhooks require an owner (public import)`);
    }
  } else {
    const owner = ownerId; // TypeScript narrowing: hasOwner guarantees non-null
    for (const w of bundle.readWebhooks()) {
      const agentId = agentIdMap.get(w.agentName);
      if (!agentId) continue;

      try {
        // Check if webhook already exists (idempotency)
        const existing = await db.webhook.findFirst({ where: { agentId } });
        if (existing) continue;

        const { id, secret } = await createWebhook(agentId, owner, db);
        webhookSecrets.push({ agentName: w.agentName, secret });

        if (!w.enabled) {
          await db.webhook.update({
            where: { id },
            data: { status: "disabled" },
          });
        }
      } catch (err) {
        warnings.push(`webhook ${w.agentName}: failed to create (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }

  // Step 8: Budget groups
  if (!hasOwner) {
    // Budget groups require an owner - skip in public import mode
    for (const b of bundle.readBudgets()) {
      const mapped = mapBudget(b);
      if (mapped.ok) {
        warnings.push(`budget group ${mapped.group.name}: skipped — budget groups require an owner (public import)`);
      }
    }
  } else {
    const owner = ownerId; // TypeScript narrowing: hasOwner guarantees non-null
    const budgetGroupMap = new Map<string, string>(); // budget name -> groupId
    const agentBudgetAssignments = new Map<string, string>(); // agent name -> first budget that claimed it

    for (const b of bundle.readBudgets()) {
      const mapped = mapBudget(b);
      if (!mapped.ok) continue;

      const { group, agentNames } = mapped;

      try {
        const bg = await db.budgetGroup.upsert({
          where: { ownerId_name: { ownerId: owner, name: group.name } },
          create: {
            name: group.name,
            ownerId: owner,
            dailyBudgetUsd: group.dailyBudgetUsd,
            weeklyBudgetUsd: group.weeklyBudgetUsd,
            monthlyBudgetUsd: group.monthlyBudgetUsd,
            warnThresholdRatio: group.warnThresholdRatio,
          },
          update: {},
        });
        budgetGroupMap.set(group.name, bg.id);
        budgetGroupsCreated++;

        // Attach agents (first budget wins)
        for (const agentName of agentNames) {
          const agentId = agentIdMap.get(agentName);
          if (!agentId) continue;

          const existingBudget = agentBudgetAssignments.get(agentName);
          if (existingBudget) {
            warnings.push(`agent ${agentName}: already in budget group "${existingBudget}", ignoring "${group.name}"`);
            continue;
          }

          try {
            await db.agent.update({
              where: { id: agentId },
              data: { budgetGroupId: bg.id },
            });
            agentBudgetAssignments.set(agentName, group.name);
          } catch (err) {
            warnings.push(
              `agent ${agentName}: failed to attach to budget group "${group.name}" (${err instanceof Error ? err.message : String(err)})`,
            );
          }
        }
      } catch (err) {
        warnings.push(
          `budget group ${group.name}: failed to create (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }

  return {
    agentsCreated,
    toolsCreated,
    secretsCreated,
    datastoreEntries,
    datastoresSharedCreated,
    budgetGroupsCreated,
    webhookSecrets,
    pendingSecretReentry,
    warnings,
  };
}
