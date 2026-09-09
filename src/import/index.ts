/**
 * Top-level orchestrator: opens a bundle, runs preflight reconciliation,
 * renders the report, and (unless dry-run or fatal collision) creates entities.
 */

import type { PrismaClient } from "@prisma/client";
import type { ConflictPolicy } from "./preflight.js";
import { openBundle } from "./bundle.js";
import { preflight } from "./preflight.js";
import { renderReconciliation } from "./report.js";
import { createFromBundle, type ImportResult } from "./create.js";
import { supportedGlobalsFromPrelude } from "./tool-scan.js";
import { SANDBOX_PRELUDE } from "../sandbox/prelude.js";
import { resolveLlmRegistrations } from "../providers/llm/registration.js";
import { RoutingLlmProvider } from "../providers/llm/routing.js";
import { loadProviderConfig } from "../config/providers.js";
import { buildSecretCipher } from "../providers/secrets/index.js";
import { resolvePrincipal } from "../mcp/auth/principal.js";
import { loadTransferPrivateKey, transferKeyIdOf } from "../providers/secrets/transfer-envelope.js";
import { readFileSync } from "node:fs";

export interface ImportOptions {
  dir: string;
  owner: string | null;
  isPublic: boolean;
  includeSecrets: boolean;
  transferKeyPath?: string;
  defaultBudget?: string;
  dryRun: boolean;
  prefix: string;
  onConflict: ConflictPolicy;
  allowOpenFetch: boolean;
  db: PrismaClient;
  env?: NodeJS.ProcessEnv;
}

export async function runImport(opts: ImportOptions): Promise<{ report: string; result?: ImportResult }> {
  const env = opts.env ?? process.env;

  // Guard: owner XOR public
  if (opts.owner === null && !opts.isPublic) {
    throw new Error("Must specify either --owner or --public (not neither)");
  }
  if (opts.owner !== null && opts.isPublic) {
    throw new Error("Cannot specify both --owner and --public");
  }

  // Open bundle
  const bundle = openBundle(opts.dir);

  // Determine effective secret mode: envelope only if bundle is envelope AND --include-secrets
  const effectiveSecretMode: "references" | "envelope" =
    bundle.manifest.secretMode === "envelope" && opts.includeSecrets ? "envelope" : "references";

  // Build routableModels from LLM registrations
  const reg = resolveLlmRegistrations(env);
  const routableModels = reg.kind === "registrations"
    ? new Set(new RoutingLlmProvider(reg.registrations).listModels())
    : new Set<string>();

  // Get supportedGlobals from prelude
  const supportedGlobals = supportedGlobalsFromPrelude(SANDBOX_PRELUDE);

  // Load existing names from db
  const existingAgents = await opts.db.agent.findMany({ select: { name: true } });
  const existingAgentNames = new Set(existingAgents.map((a) => a.name));

  const existingTools = await opts.db.tool.findMany({ select: { name: true } });
  const existingToolNames = new Set(existingTools.map((t) => t.name));

  // For owner-scoped entities (secrets, budgets), load only if we have an owner
  const ownerId = opts.owner !== null && !opts.isPublic
    ? (await resolvePrincipal(opts.owner, opts.db)).id
    : null;

  const existingSecrets = ownerId
    ? await opts.db.secret.findMany({ where: { ownerId }, select: { name: true } })
    : [];
  const existingSecretNames = new Set(existingSecrets.map((s) => s.name));

  const existingBudgetGroups = ownerId
    ? await opts.db.budgetGroup.findMany({ where: { ownerId }, select: { name: true } })
    : [];
  const existingBudgetGroupNames = new Set(existingBudgetGroups.map((b) => b.name));

  // Tier-1 capabilities: only "budgets" is implemented
  const capabilitiesSupported = new Set(["budgets"]);

  // Run preflight reconciliation
  const recon = preflight({
    bundle,
    routableModels,
    supportedGlobals,
    existingAgentNames,
    existingToolNames,
    capabilitiesSupported,
    onConflict: opts.onConflict,
    prefix: opts.prefix,
    allowOpenFetch: opts.allowOpenFetch,
  });

  // Render initial report
  let report = renderReconciliation(recon, {
    secretMode: bundle.manifest.secretMode,
    dryRun: opts.dryRun,
  });

  // Early return if dry-run or fatal collision
  if (recon.hasFatalCollision && !opts.dryRun) {
    report +=
      "\n\n*** Import aborted: a name collision was found under --on-conflict fail. No changes were written. ***";
    return { report };
  }
  if (opts.dryRun || recon.hasFatalCollision) {
    return { report };
  }

  // Load and verify transfer key (only when actually importing secrets from envelope)
  let transferPrivateKey = undefined;
  if (effectiveSecretMode === "envelope") {
    if (!opts.transferKeyPath) {
      throw new Error("Importing secrets from an envelope bundle requires --transfer-key");
    }
    const keyPem = readFileSync(opts.transferKeyPath, "utf8");
    transferPrivateKey = loadTransferPrivateKey(keyPem);
    const keyId = transferKeyIdOf(transferPrivateKey);
    if (keyId !== bundle.manifest.transferKeyId) {
      throw new Error(
        `Transfer key ID mismatch: key has ${keyId}, bundle manifest declares ${bundle.manifest.transferKeyId}`
      );
    }
  }

  // Build secret cipher
  const providerConfig = loadProviderConfig(env);
  const cipher = buildSecretCipher(providerConfig, env);

  // Run create
  const result = await createFromBundle(bundle, recon, {
    db: opts.db,
    cipher,
    ownerId,
    defaultBudget: opts.defaultBudget ?? "10.00",
    secretMode: effectiveSecretMode,
    transferPrivateKey,
    allowOpenFetch: opts.allowOpenFetch,
  });

  // Append final report sections
  const finalLines: string[] = [];
  finalLines.push("");
  finalLines.push("--- Import Complete ---");
  finalLines.push(`Agents created: ${result.agentsCreated}`);
  finalLines.push(`Tools created: ${result.toolsCreated}`);
  finalLines.push(`Secrets created: ${result.secretsCreated}`);
  finalLines.push(`Datastore entries: ${result.datastoreEntries}`);
  finalLines.push(`Budget groups created: ${result.budgetGroupsCreated}`);

  if (result.webhookSecrets.length > 0) {
    finalLines.push("");
    finalLines.push("Webhook secrets (save these now, they won't be shown again):");
    for (const ws of result.webhookSecrets) {
      finalLines.push(`  ${ws.agentName}: ${ws.secret}`);
    }
  }

  if (result.pendingSecretReentry.length > 0) {
    finalLines.push("");
    finalLines.push("Pending secret re-entry (references mode):");
    for (const name of result.pendingSecretReentry) {
      finalLines.push(`  - ${name}`);
    }
  }

  if (result.warnings.length > 0) {
    finalLines.push("");
    finalLines.push("Warnings:");
    for (const w of result.warnings) {
      finalLines.push(`  - ${w}`);
    }
  }

  report += "\n" + finalLines.join("\n");

  return { report, result };
}
