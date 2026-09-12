import { z } from "zod";

export const CiphertextSchema = z.object({
  v: z.number(),
  alg: z.string(),
  epk: z.string(),
  nonce: z.string(),
  ct: z.string(),
  tag: z.string(),
});

export const ManifestSchema = z.object({
  bundleVersion: z.number(),
  source: z.object({ product: z.string(), exporterVersion: z.string(), exportedAt: z.string() }),
  secretMode: z.enum(["references", "envelope"]),
  transferKeyId: z.string().nullable().default(null),
  contentWindowDays: z.number().nullable().default(null),
  contentSince: z.string().nullable().default(null),
  toolCallDetail: z.enum(["metadata", "full"]).default("metadata"),
  runAuditWindowDays: z.number().nullable().default(null),
  runAuditSince: z.string().nullable().default(null),
  capabilities: z.array(z.string()),
  counts: z.record(z.string(), z.number()),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const NeutralAgentSchema = z.object({
  name: z.string(),
  systemPrompt: z.string(),
  provider: z.enum(["openai", "bedrock"]),
  model: z.string(),
  region: z.string().nullable().default(null),
  schedule: z.string().nullable().default(null), // "" or null both mean manual-only
  timezone: z.string().default("UTC"),
  scheduleEnabled: z.boolean(),
  maxTurns: z.number().int(),
  budgetUsd: z.string(),
  ownerEmail: z.string().nullable().default(null),
  kind: z.enum(["native"]).default("native"),
  memoryEnabled: z.boolean().default(false),
  unmodeled: z
    .object({
      description: z.string().nullable().default(null),
      slug: z.string().nullable().default(null),
      emailAllowlist: z.unknown().nullable().default(null),
    })
    .partial()
    .default({}),
});
export type NeutralAgent = z.infer<typeof NeutralAgentSchema>;

export const NeutralToolSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  paramsZod: z.string(),
  jsonSchema: z.unknown().nullable().default(null), // ignored; we re-derive (ruling 2)
  code: z.string(),
  secretSchema: z.string().default(""),
});
export type NeutralTool = z.infer<typeof NeutralToolSchema>;

export const NeutralAgentToolSchema = z.object({
  agentName: z.string(),
  toolName: z.string(),
  allowedSecrets: z.array(z.string()).default([]),
  allowedDatastorePrefixes: z.array(z.string()).default([]),
  allowedHosts: z.array(z.string()).default([]),
  hostsSource: z.string().optional(),
});
export type NeutralAgentTool = z.infer<typeof NeutralAgentToolSchema>;

export const NeutralSecretSchema = z.object({
  name: z.string(),
  description: z.string().nullable().default(null),
  ownerEmail: z.string().nullable().default(null),
  ciphertext: CiphertextSchema.optional(),
});
export type NeutralSecret = z.infer<typeof NeutralSecretSchema>;

export const NeutralAgentSecretSchema = z.object({
  agentName: z.string(),
  secretName: z.string(),
  alias: z.string().nullable().default(null),
});
export type NeutralAgentSecret = z.infer<typeof NeutralAgentSecretSchema>;

export const NeutralSingleDatastoreSchema = z.object({
  agentName: z.string(),
  name: z.string().optional(),
  entries: z
    .array(
      z.object({
        key: z.string(),
        value: z.unknown(),
        pii: z.boolean().default(false),
      }),
    )
    .default([]),
});
export type NeutralSingleDatastore = z.infer<typeof NeutralSingleDatastoreSchema>;

export const NeutralWebhookSchema = z.object({
  agentName: z.string(),
  enabled: z.boolean(),
});
export type NeutralWebhook = z.infer<typeof NeutralWebhookSchema>;

export const NeutralBudgetSchema = z.object({
  name: z.string(),
  ownerEmail: z.string().nullable().default(null),
  period: z.enum(["daily", "weekly", "monthly"]),
  alertThreshold: z.string(),
  blockThreshold: z.string(),
  alertEmails: z.array(z.string()).default([]),
  enabled: z.boolean(),
  attachedAgentNames: z.array(z.string()).default([]),
});
export type NeutralBudget = z.infer<typeof NeutralBudgetSchema>;
