/**
 * Host providers over MCP (docs/host-providers.md). Everything here needs hosts:admin, a
 * privileged scope honoured only with a role granting it (host-manager or admin; the stdio
 * operator holds both): bound tools decide who has permission and who wrote a comment, and
 * they run in the push and pull request flow. Results carry secret names, never values.
 */
import { z } from "zod";
import { logger } from "../../core/logger.js";
import {
  approveHostProviderTools,
  deleteHostProvider,
  getHostProviderView,
  HostProviderError,
  registerHostProvider,
  RegisterHostProviderSchema,
} from "../../providers/host-tools/registry.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

const hostsLog = logger.child({ module: "mcp-host-providers" });

function audit(ctx: McpRequestContext, action: string, provider: string, extra: Record<string, unknown> = {}): void {
  hostsLog.info(
    { event: `hosts.provider.${action}`, provider, by: ctx.principal.id, ...extra },
    "host provider changed",
  );
}

function parse<Output>(schema: z.ZodType<Output, unknown>, label: string, value: unknown): Output {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details = result.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  throw new McpError(400, `Invalid ${label}: ${details}`);
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof HostProviderError) {
      throw new McpError(err.code === "host_provider_not_found" ? 404 : 400, err.message);
    }
    throw err;
  }
}

const ApproveSchema = z
  .object({ provider: z.string().min(1).max(40), tools: z.array(z.string().min(1).max(100)).min(1) })
  .strict();
const GetSchema = z.object({ provider: z.string().min(1).max(40), includeCode: z.boolean().optional() }).strict();
const DeleteSchema = z.object({ provider: z.string().min(1).max(40) }).strict();

export function registerHostProviderTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "register_host_provider",
    scope: "hosts:admin",
    description:
      "Host managers (hosts:admin): register a code host implemented by your custom tools, or replace one. Each tool's code and schema are copied, and only that copy ever runs: update_tool changes nothing until approve_host_provider_tools. Credentials must be your brokered secrets, allowed on every API host and gitHost. Without permissionCredential, trustedAccounts decides who may start runs. A new provider takes effect after a server restart.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "provider",
        "gitHost",
        "apiHosts",
        "gitUsername",
        "pullRequestUrlTemplate",
        "repositoryApiPath",
        "webhook",
        "credentials",
        "tools",
      ],
      properties: {
        provider: { type: "string", description: "Prefix of its repository ids: <provider>:<workspace>/<repo>." },
        gitHost: { type: "string" },
        apiHosts: { type: "array", items: { type: "string" } },
        gitUsername: { type: "string" },
        pullRequestUrlTemplate: { type: "string", description: "https URL on gitHost with {repository} and {number}." },
        repositoryApiPath: { type: "string", description: "API path of one repository, with {repository}." },
        permissionApiPath: { type: "string", description: "Permission endpoint path, with {workspace} and {repo}." },
        webhook: {
          type: "object",
          additionalProperties: false,
          required: ["header", "algorithm", "deliveryHeader", "eventHeader", "secret"],
          properties: {
            header: { type: "string" },
            algorithm: { type: "string", enum: ["sha256"] },
            deliveryHeader: { type: "string" },
            eventHeader: { type: "string" },
            secret: { type: "string", description: "Name of your secret; not attached to any agent." },
          },
        },
        credentials: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["repositories", "secret"],
            properties: {
              repositories: { type: "string", description: '"workspace/repo" or "workspace/*".' },
              secret: { type: "string" },
            },
          },
        },
        permissionCredential: { type: "string" },
        trustedAccounts: { type: "array", items: { type: "string" } },
        tools: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Operation name to your tool's name.",
        },
      },
    },
    handler: async (rawArgs: unknown, ctx) => {
      const input = parse(RegisterHostProviderSchema, "register_host_provider arguments", rawArgs);
      const view = await mapped(() => registerHostProvider(ctx.db, ctx.providers.secrets, ctx.principal.id, input));
      audit(ctx, "register", view.provider, { mode: view.mode, operations: view.operations.length });
      return textResult({
        ...view,
        restartRequired: true,
        note:
          view.mode === "permission"
            ? "Permission mode: the host decides who has access, and a failed lookup refuses."
            : "Allowlist mode: only trustedAccounts may start runs, at write level.",
      });
    },
  });

  mcp.registerTool({
    name: "approve_host_provider_tools",
    scope: "hosts:admin",
    description:
      "Host managers (hosts:admin): copy the named operations' current tool code over their approved snapshots. Applies from the next call. Read the change first with get_host_provider and includeCode.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "tools"],
      properties: {
        provider: { type: "string" },
        tools: { type: "array", items: { type: "string" }, description: "Operation names." },
      },
    },
    handler: async (rawArgs: unknown, ctx) => {
      const { provider, tools } = parse(ApproveSchema, "approve_host_provider_tools arguments", rawArgs);
      const view = await mapped(() => approveHostProviderTools(ctx.db, ctx.principal.id, provider, tools));
      audit(ctx, "approve", provider, { operations: tools });
      return textResult(view);
    },
  });

  mcp.registerTool({
    name: "get_host_provider",
    scope: "hosts:admin",
    description:
      "Host managers (hosts:admin): a provider's config, active permission mode, secret names (never values), and which tools have unapproved changes. includeCode adds each approved snapshot and any newer tool code, to review before approving.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["provider"],
      properties: { provider: { type: "string" }, includeCode: { type: "boolean" } },
    },
    handler: async (rawArgs: unknown, ctx) => {
      const { provider, includeCode } = parse(GetSchema, "get_host_provider arguments", rawArgs);
      const view = await getHostProviderView(ctx.db, provider, { includeCode });
      if (!view) throw new McpError(404, `Host provider "${provider}" not found.`);
      return textResult(view);
    },
  });

  mcp.registerTool({
    name: "delete_host_provider",
    scope: "hosts:admin",
    description:
      "Host managers (hosts:admin): remove a provider and its snapshots, freeing its secrets. Refused while an agent links to one of its repositories.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["provider"],
      properties: { provider: { type: "string" } },
    },
    handler: async (rawArgs: unknown, ctx) => {
      const { provider } = parse(DeleteSchema, "delete_host_provider arguments", rawArgs);
      await mapped(() => deleteHostProvider(ctx.db, provider));
      audit(ctx, "delete", provider);
      return textResult({ deleted: provider });
    },
  });
}
