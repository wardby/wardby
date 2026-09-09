import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ManifestSchema, NeutralAgentSchema, NeutralToolSchema, NeutralAgentToolSchema,
  NeutralSecretSchema, NeutralAgentSecretSchema, NeutralSingleDatastoreSchema,
  NeutralWebhookSchema, NeutralBudgetSchema,
  type Manifest, type NeutralAgent, type NeutralTool, type NeutralAgentTool,
  type NeutralSecret, type NeutralAgentSecret, type NeutralSingleDatastore,
  type NeutralWebhook, type NeutralBudget,
} from "./neutral-schema.js";

export class BundleError extends Error {}

function readArray<T>(dir: string, rel: string, schema: z.ZodType<T>): T[] {
  const p = join(dir, rel);
  if (!existsSync(p)) return [];
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { throw new BundleError(`${rel}: invalid JSON (${(e as Error).message})`); }
  const parsed = z.array(schema).safeParse(raw);
  if (!parsed.success) throw new BundleError(`${rel}: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  return parsed.data;
}

export interface Bundle {
  manifest: Manifest;
  readAgents(): NeutralAgent[];
  readTools(): NeutralTool[];
  readAgentTools(): NeutralAgentTool[];
  readSecrets(): NeutralSecret[];
  readAgentSecrets(): NeutralAgentSecret[];
  readSingleDatastores(): NeutralSingleDatastore[];
  readWebhooks(): NeutralWebhook[];
  readBudgets(): NeutralBudget[];
}

export function openBundle(dir: string): Bundle {
  let st;
  try { st = statSync(dir); } catch { throw new BundleError(`no such bundle directory: ${dir}`); }
  if (!st.isDirectory()) throw new BundleError(`bundle path is not a directory (extract the .zip first): ${dir}`);

  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) throw new BundleError("manifest.json not found in bundle");
  const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!parsed.success) throw new BundleError(`manifest.json: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const manifest = parsed.data;
  if (manifest.bundleVersion !== 1) throw new BundleError(`unsupported bundleVersion ${manifest.bundleVersion}`);

  return {
    manifest,
    readAgents: () => readArray(dir, "config/agents.json", NeutralAgentSchema),
    readTools: () => readArray(dir, "config/tools.json", NeutralToolSchema),
    readAgentTools: () => readArray(dir, "config/agent-tools.json", NeutralAgentToolSchema),
    readSecrets: () => readArray(dir, "config/secrets.json", NeutralSecretSchema),
    readAgentSecrets: () => readArray(dir, "config/agent-secrets.json", NeutralAgentSecretSchema),
    readSingleDatastores: () => readArray(dir, "config/datastores-single.json", NeutralSingleDatastoreSchema),
    readWebhooks: () => readArray(dir, "config/webhooks.json", NeutralWebhookSchema),
    readBudgets: () => readArray(dir, "capabilities/budgets.json", NeutralBudgetSchema),
  };
}
