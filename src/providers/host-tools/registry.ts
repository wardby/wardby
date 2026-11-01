/**
 * Registering a tool-backed host provider, approving its tools, and reading it back.
 * Registering copies each tool's code and schema: Wardby only ever runs that copy, so
 * update_tool changes nothing until approved, and a stray edit can't take a provider down.
 * Views carry secret names and metadata, never a value.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "#prisma";
import { isValidHostProviderName } from "../../coding/code-host.js";
import { isExactHostname, parseSecretBrokerConfig, type SecretBrokerConfig } from "../../core/secret-broker-config.js";
import type { SecretCipher } from "../secrets/types.js";
import { HOST_TOOL_CONTRACT_VERSION, isHostOperation, REQUIRED_OPERATIONS, type HostOperation } from "./operations.js";

export type HostProviderErrorCode =
  | "host_provider_not_found"
  | "host_provider_missing_operation"
  | "host_provider_tool_not_found"
  | "host_provider_secret_not_found"
  | "host_provider_secret_not_brokered"
  | "host_provider_secret_hosts"
  | "host_provider_secret_placement"
  | "host_provider_webhook_secret_shared"
  | "host_provider_webhook_secret_short"
  | "host_provider_permission_secret_shared"
  | "host_provider_username_is_secret"
  | "host_provider_in_use"
  | "host_provider_operation_not_bound"
  | "host_provider_tool_deleted";

export class HostProviderError extends Error {
  constructor(
    readonly code: HostProviderErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "HostProviderError";
  }
}

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const MIN_WEBHOOK_SECRET_LENGTH = 16;
const REPOSITORY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}\/(?:\*|[a-z0-9][a-z0-9._-]{0,99})$/;
const SECRET_NAME = z.string().min(1).max(1024);

const hostname = z
  .string()
  .transform((h) => h.toLowerCase())
  .refine(isExactHostname, "must be an exact hostname, with no scheme, port, wildcard or IP");

/** Each of `fields` once, and no other `{...}`. */
function hasExactlyFields(template: string, fields: readonly string[]): boolean {
  const found = [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]).sort();
  return JSON.stringify(found) === JSON.stringify([...fields].sort());
}

const apiPath = (fields: readonly string[]) =>
  z
    .string()
    .max(512)
    .startsWith("/")
    .refine((p) => hasExactlyFields(p, fields), `must contain ${fields.map((f) => `{${f}}`).join(" and ")} once each`)
    // eslint-disable-next-line no-control-regex
    .refine((p) => !/[?#\\\x00-\x20\x7f]|%2f|%5c|\.\./i.test(p), "must be a plain path");

export const RegisterHostProviderSchema = z
  .object({
    provider: z.string().refine(isValidHostProviderName, "reserved or badly formed provider name"),
    gitHost: hostname,
    apiHosts: z.array(hostname).min(1).max(8),
    // Refused: a name git's password prompt would contain, since scripts/git-askpass.sh answers by matching "Username".
    gitUsername: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .refine((u) => !/username/i.test(u), 'must not contain "username"'),
    pullRequestUrlTemplate: z.string().max(512),
    repositoryApiPath: apiPath(["repository"]),
    permissionApiPath: apiPath(["workspace", "repo"]).optional(),
    webhook: z
      .object({
        header: z.string().regex(HTTP_TOKEN),
        algorithm: z.literal("sha256"),
        deliveryHeader: z.string().regex(HTTP_TOKEN),
        eventHeader: z.string().regex(HTTP_TOKEN),
        secret: SECRET_NAME,
      })
      .strict(),
    credentials: z
      .array(
        z
          .object({
            repositories: z
              .string()
              .transform((r) => r.toLowerCase())
              .refine((r) => REPOSITORY_PATTERN.test(r), 'must be "workspace/repo" or "workspace/*"'),
            secret: SECRET_NAME,
          })
          .strict(),
      )
      .min(1)
      .max(32),
    permissionCredential: SECRET_NAME.optional(),
    trustedAccounts: z
      .array(z.string().regex(/^[A-Za-z0-9:{}_-]{1,128}$/))
      .max(256)
      .optional(),
    tools: z.record(z.string(), z.string().min(1).max(200)),
  })
  .strict()
  .superRefine((input, ctx) => {
    let template: URL | null = null;
    try {
      template = new URL(input.pullRequestUrlTemplate.replaceAll(/[{}]/g, ""));
    } catch {
      // reported below
    }
    if (
      !template ||
      template.protocol !== "https:" ||
      template.hostname !== input.gitHost ||
      !hasExactlyFields(input.pullRequestUrlTemplate, ["repository", "number"])
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["pullRequestUrlTemplate"],
        message: "must be an https URL on gitHost with {repository} and {number} once each",
      });
    }
    if ((input.permissionCredential === undefined) !== (input.permissionApiPath === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["permissionApiPath"],
        message: "permissionCredential and permissionApiPath go together",
      });
    }
    const patterns = input.credentials.map((c) => c.repositories);
    if (new Set(patterns).size !== patterns.length) {
      ctx.addIssue({ code: "custom", path: ["credentials"], message: "a repository pattern is listed twice" });
    }
  });

export type RegisterHostProviderInput = z.infer<typeof RegisterHostProviderSchema>;

export function findCredential<T extends { repositoryPattern: string }>(
  credentials: readonly T[],
  repositoryPath: string,
): T | null {
  const parts = repositoryPath.split("/");
  if (parts.length !== 2) return null;
  return (
    credentials.find((c) => c.repositoryPattern === repositoryPath) ??
    credentials.find((c) => c.repositoryPattern === `${parts[0]}/*`) ??
    null
  );
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const snapshotHash = (s: { code: string; paramsZod: string }) => sha256(`${s.paramsZod}\u0000${s.code}`);

export interface OperationView {
  operation: string;
  toolName: string | null;
  status: "approved" | "changed" | "tool_deleted";
  approvedAt: Date;
  approvedById: string;
  approvedSha256: string;
  currentSha256: string | null;
  approvedCode?: string;
  currentCode?: string;
}

export interface HostProviderView {
  provider: string;
  contractVersion: number;
  gitHost: string;
  apiHosts: string[];
  gitUsername: string;
  pullRequestUrlTemplate: string;
  repositoryApiPath: string;
  permissionApiPath: string | null;
  mode: "permission" | "allowlist";
  webhook: unknown;
  webhookSecret: string;
  permissionSecret: string | null;
  credentials: { repositories: string; secret: string; kind: string }[];
  trustedAccounts: string[];
  operations: OperationView[];
}

type Tx = Prisma.TransactionClient;

async function requireSecret(tx: Tx, ownerId: string, name: string) {
  const secret = await tx.secret.findUnique({ where: { ownerId_name: { ownerId, name } } });
  if (!secret) throw new HostProviderError("host_provider_secret_not_found", `secret "${name}" not found`);
  return secret;
}

function requireBroker(name: string, stored: unknown, hosts: readonly string[]): SecretBrokerConfig {
  if (stored === null || stored === undefined) {
    throw new HostProviderError("host_provider_secret_not_brokered", `secret "${name}" must be brokered`);
  }
  const broker = parseSecretBrokerConfig(stored);
  if (broker.placement.kind !== "header" && broker.placement.kind !== "query") {
    throw new HostProviderError(
      "host_provider_secret_placement",
      `secret "${name}" must be placed in a header or query parameter`,
    );
  }
  const missing = hosts.filter((h) => !broker.hosts.includes(h));
  if (missing.length > 0) {
    throw new HostProviderError("host_provider_secret_hosts", `secret "${name}" must allow ${missing.join(", ")}`);
  }
  return broker;
}

export async function registerHostProvider(
  db: PrismaClient,
  cipher: SecretCipher,
  principalId: string,
  input: RegisterHostProviderInput,
): Promise<HostProviderView> {
  const bound = Object.keys(input.tools);
  const unknown = bound.filter((name) => !isHostOperation(name));
  if (unknown.length > 0) {
    throw new HostProviderError("host_provider_operation_not_bound", `unknown operations: ${unknown.join(", ")}`);
  }
  const required: readonly HostOperation[] = input.permissionCredential
    ? [...REQUIRED_OPERATIONS, "getRepositoryPermission"]
    : REQUIRED_OPERATIONS;
  const missing = required.filter((name) => !bound.includes(name));
  if (missing.length > 0) {
    throw new HostProviderError("host_provider_missing_operation", `missing operations: ${missing.join(", ")}`);
  }

  await db.$transaction(
    async (tx) => {
      const credentials = [];
      for (const credential of input.credentials) {
        const secret = await requireSecret(tx, principalId, credential.secret);
        requireBroker(credential.secret, secret.broker, [...input.apiHosts, input.gitHost]);
        if ((await cipher.decrypt(secret.ciphertext)) === input.gitUsername) {
          throw new HostProviderError(
            "host_provider_username_is_secret",
            "gitUsername must not be a credential's value",
          );
        }
        credentials.push({ repositoryPattern: credential.repositories, secretId: secret.id });
      }
      let permissionSecretId: string | null = null;
      if (input.permissionCredential) {
        const secret = await requireSecret(tx, principalId, input.permissionCredential);
        requireBroker(input.permissionCredential, secret.broker, input.apiHosts);
        permissionSecretId = secret.id;
        if (credentials.some((c) => c.secretId === secret.id)) {
          throw new HostProviderError(
            "host_provider_permission_secret_shared",
            "the permission secret must not also be a credential, so no other operation can reach it",
          );
        }
      }
      const webhookSecret = await requireSecret(tx, principalId, input.webhook.secret);
      if (
        credentials.some((c) => c.secretId === webhookSecret.id) ||
        permissionSecretId === webhookSecret.id ||
        (await tx.agentSecret.count({ where: { secretId: webhookSecret.id } })) > 0 ||
        (await tx.hostProviderCredential.count({
          where: { secretId: webhookSecret.id, provider: { not: input.provider } },
        })) > 0 ||
        (await tx.hostProvider.count({
          where: { permissionSecretId: webhookSecret.id, name: { not: input.provider } },
        })) > 0 ||
        (await tx.hostProvider.count({
          where: {
            webhookSecretId: {
              in: [...credentials.map((c) => c.secretId), ...(permissionSecretId ? [permissionSecretId] : [])],
            },
            name: { not: input.provider },
          },
        })) > 0
      ) {
        throw new HostProviderError(
          "host_provider_webhook_secret_shared",
          "the webhook secret must not be shared with any other provider's credentials or attached to an agent, so no tool can read it",
        );
      }
      if ((await cipher.decrypt(webhookSecret.ciphertext)).length < MIN_WEBHOOK_SECRET_LENGTH) {
        throw new HostProviderError(
          "host_provider_webhook_secret_short",
          `the webhook secret needs at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`,
        );
      }
      const operations = [];
      for (const [operation, name] of Object.entries(input.tools)) {
        const tool = await tx.tool.findUnique({ where: { ownerId_name: { ownerId: principalId, name } } });
        if (!tool) throw new HostProviderError("host_provider_tool_not_found", `tool "${name}" not found`);
        operations.push({
          operation,
          toolId: tool.id,
          code: tool.code,
          paramsZod: tool.paramsZod,
          approvedById: principalId,
        });
      }
      const { secret: _webhookSecretName, ...webhook } = input.webhook;
      const fields = {
        contractVersion: HOST_TOOL_CONTRACT_VERSION,
        gitHost: input.gitHost,
        apiHosts: input.apiHosts,
        gitUsername: input.gitUsername,
        pullRequestUrlTemplate: input.pullRequestUrlTemplate,
        repositoryApiPath: input.repositoryApiPath,
        permissionApiPath: input.permissionApiPath ?? null,
        webhook,
        webhookSecretId: webhookSecret.id,
        permissionSecretId,
        createdById: principalId,
      };
      await tx.hostProvider.upsert({
        where: { name: input.provider },
        create: { name: input.provider, ...fields },
        update: fields,
      });
      await tx.hostProviderOperation.deleteMany({ where: { provider: input.provider } });
      await tx.hostProviderCredential.deleteMany({ where: { provider: input.provider } });
      await tx.hostProviderTrustedAccount.deleteMany({ where: { provider: input.provider } });
      await tx.hostProviderOperation.createMany({ data: operations.map((o) => ({ provider: input.provider, ...o })) });
      await tx.hostProviderCredential.createMany({
        data: credentials.map((c) => ({ provider: input.provider, credentialKind: "static", ...c })),
      });
      await tx.hostProviderTrustedAccount.createMany({
        data: [...new Set(input.trustedAccounts ?? [])].map((accountId) => ({
          provider: input.provider,
          accountId,
          addedById: principalId,
        })),
      });
    },
    { isolationLevel: "Serializable" },
  );
  return (await getHostProviderView(db, input.provider))!;
}

export async function approveHostProviderTools(
  db: PrismaClient,
  principalId: string,
  provider: string,
  operations: readonly string[],
): Promise<HostProviderView> {
  await db.$transaction(
    async (tx) => {
      if (!(await tx.hostProvider.findUnique({ where: { name: provider } }))) {
        throw new HostProviderError("host_provider_not_found", `provider "${provider}" not found`);
      }
      for (const operation of operations) {
        const row = await tx.hostProviderOperation.findUnique({
          where: { provider_operation: { provider, operation } },
          include: { tool: true },
        });
        if (!row) throw new HostProviderError("host_provider_operation_not_bound", `"${operation}" isn't bound`);
        if (!row.tool) throw new HostProviderError("host_provider_tool_deleted", `"${operation}"'s tool was deleted`);
        await tx.hostProviderOperation.update({
          where: { provider_operation: { provider, operation } },
          data: {
            code: row.tool.code,
            paramsZod: row.tool.paramsZod,
            approvedById: principalId,
            approvedAt: new Date(),
          },
        });
      }
    },
    { isolationLevel: "Serializable" },
  );
  return (await getHostProviderView(db, provider))!;
}

export async function getHostProviderView(
  db: PrismaClient,
  provider: string,
  options: { includeCode?: boolean } = {},
): Promise<HostProviderView | null> {
  const row = await db.hostProvider.findUnique({
    where: { name: provider },
    include: {
      webhookSecret: { select: { name: true } },
      permissionSecret: { select: { name: true } },
      credentials: { include: { secret: { select: { name: true } } }, orderBy: { repositoryPattern: "asc" } },
      trustedAccounts: { orderBy: { accountId: "asc" } },
      operations: { include: { tool: true }, orderBy: { operation: "asc" } },
    },
  });
  if (!row) return null;
  return {
    provider: row.name,
    contractVersion: row.contractVersion,
    gitHost: row.gitHost,
    apiHosts: row.apiHosts,
    gitUsername: row.gitUsername,
    pullRequestUrlTemplate: row.pullRequestUrlTemplate,
    repositoryApiPath: row.repositoryApiPath,
    permissionApiPath: row.permissionApiPath,
    mode: row.permissionSecretId ? "permission" : "allowlist",
    webhook: row.webhook,
    webhookSecret: row.webhookSecret.name,
    permissionSecret: row.permissionSecret?.name ?? null,
    credentials: row.credentials.map((c) => ({
      repositories: c.repositoryPattern,
      secret: c.secret.name,
      kind: c.credentialKind,
    })),
    trustedAccounts: row.trustedAccounts.map((a) => a.accountId),
    operations: row.operations.map((o) => {
      const approvedSha256 = snapshotHash(o);
      const currentSha256 = o.tool ? snapshotHash(o.tool) : null;
      return {
        operation: o.operation,
        toolName: o.tool?.name ?? null,
        status: !o.tool ? "tool_deleted" : currentSha256 === approvedSha256 ? "approved" : "changed",
        approvedAt: o.approvedAt,
        approvedById: o.approvedById,
        approvedSha256,
        currentSha256,
        ...(options.includeCode
          ? {
              approvedCode: o.code,
              ...(o.tool && currentSha256 !== approvedSha256 ? { currentCode: o.tool.code } : {}),
            }
          : {}),
      };
    }),
  };
}

export async function deleteHostProvider(db: PrismaClient, provider: string): Promise<void> {
  await db.$transaction(
    async (tx) => {
      if (!(await tx.hostProvider.findUnique({ where: { name: provider } }))) {
        throw new HostProviderError("host_provider_not_found", `provider "${provider}" not found`);
      }
      const links = await tx.agentRepository.count({ where: { provider } });
      if (links > 0) throw new HostProviderError("host_provider_in_use", `${links} agent link(s) use this provider`);
      await tx.hostProvider.delete({ where: { name: provider } });
    },
    { isolationLevel: "Serializable" },
  );
}
