/**
 * The coding-run service catalog over MCP (docs/coding-services.md). Reading
 * it needs only agents:read: agent owners need to see which services exist and
 * the variables (testEnv) their tests will get before allowing one, and entries
 * hold no secrets (serviceEnv values are throwaway per-run test credentials).
 * Changing it needs services:manage, a privileged scope honoured only with a
 * role granting it (service-manager or admin; resource-server.ts): an entry
 * decides which image runs next to every coding run that names it, and with
 * what. Each change is audit-logged (event coding.service_catalog.<action>).
 * Built-in entries ship with wardby and change only with a release.
 */
import { z } from "zod";
import {
  CodingServiceDefinitionSchema,
  catalogEntryFromRow,
  codingServiceNameSchema,
  codingServiceVersionSchema,
  type CodingServiceRow,
} from "../../coding/services/catalog.js";
import { logger } from "../../core/logger.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

const servicesLog = logger.child({ module: "mcp-services" });

const KeySchema = z.object({ name: codingServiceNameSchema, version: codingServiceVersionSchema }).strict();
/** Everything but the key is optional here; the merged entry is validated in full. */
const UpdateSchema = z
  .object({
    name: codingServiceNameSchema,
    version: codingServiceVersionSchema,
    image: z.unknown().optional(),
    port: z.unknown().optional(),
    serviceEnv: z.unknown().optional(),
    testEnv: z.unknown().optional(),
    readiness: z.unknown().optional(),
    resources: z.unknown().optional(),
    dataPath: z.unknown().optional(),
    writablePaths: z.unknown().optional(),
  })
  .strict();

type Key = z.infer<typeof KeySchema>;
type CatalogRow = CodingServiceRow & { builtin: boolean; createdAt: Date; updatedAt: Date };

function parse<Output>(schema: z.ZodType<Output, unknown>, label: string, value: unknown): Output {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");
    throw new McpError(400, `Invalid ${label}: ${details}`);
  }
  return result.data;
}

function audit(ctx: McpRequestContext, action: "create" | "update" | "delete", entry: Key & { image?: string }): void {
  servicesLog.info(
    {
      event: `coding.service_catalog.${action}`,
      name: entry.name,
      version: entry.version,
      ...(entry.image ? { image: entry.image } : {}),
      by: ctx.principal.id,
    },
    "coding service catalog changed",
  );
}

async function findEntry(ctx: McpRequestContext, key: Key): Promise<CatalogRow> {
  const row = await ctx.db.codingService.findUnique({ where: { name_version: key } });
  if (!row) throw new McpError(404, `No coding service "${key.name} ${key.version}" in the catalog.`);
  return row;
}

function refuseBuiltin(key: Key): McpError {
  return new McpError(
    403,
    `"${key.name} ${key.version}" is built in: built-in services change only with a wardby release. Create an entry under another name or version instead.`,
  );
}

function view(row: CatalogRow) {
  return { ...catalogEntryFromRow(row), builtin: row.builtin, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

const keyJsonSchema = {
  name: { type: "string", description: 'Catalog name a repository declares, e.g. "postgres".' },
  version: { type: "string", description: 'Version a repository declares, e.g. "16".' },
};

const definitionProperties = {
  ...keyJsonSchema,
  image: { type: "string", description: "Registry digest to run: repo@sha256:<64 hex>. Tags are refused." },
  port: {
    type: "integer",
    minimum: 1,
    maximum: 65535,
    description: "The port the service listens on (informational).",
  },
  serviceEnv: {
    type: "object",
    additionalProperties: { type: "string" },
    description: "Environment for the service container. Throwaway per-run values only, never secrets.",
  },
  testEnv: {
    type: "object",
    additionalProperties: { type: "string" },
    description:
      "Variables the agent's shells receive (e.g. DATABASE_URL). Upper-case names; wardby's own names (PATH, HOME, PIP_*, WARDBY_*, ...) are refused.",
  },
  readiness: {
    type: "object",
    additionalProperties: false,
    required: ["command", "periodSeconds", "timeoutSeconds", "failureThreshold"],
    properties: {
      command: { type: "array", minItems: 1, maxItems: 16, items: { type: "string" } },
      periodSeconds: { type: "integer", minimum: 1, maximum: 60 },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 60 },
      failureThreshold: { type: "integer", minimum: 1, maximum: 120 },
    },
    description:
      "Startup probe: a command in the service's image that succeeds once it accepts connections on 127.0.0.1.",
  },
  resources: {
    type: "object",
    additionalProperties: false,
    required: ["cpuMillicores", "memoryMib", "diskMib"],
    properties: {
      cpuMillicores: { type: "integer", minimum: 100, maximum: 4000 },
      memoryMib: { type: "integer", minimum: 64, maximum: 16384 },
      diskMib: { type: "integer", minimum: 64, maximum: 8192 },
    },
    description: "Requests equal limits. diskMib sizes the data volume.",
  },
  dataPath: {
    type: "string",
    description: "Absolute directory the service writes its data to: an empty volume in each run.",
  },
  writablePaths: {
    type: "array",
    maxItems: 4,
    items: { type: "string" },
    description:
      "Further directories the image writes to (a socket directory, /tmp); its root filesystem is read-only.",
  },
};

export function registerServiceTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "list_services",
    scope: "agents:read",
    description:
      "The coding-run service catalog (name, version, image, built in or not): the names a coding agent's codingProfile.services can allow.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    handler: async (_args: Record<string, never>, ctx) => {
      const rows = await ctx.db.codingService.findMany({ orderBy: [{ name: "asc" }, { version: "asc" }] });
      return textResult(
        rows.map((row) => ({
          name: row.name,
          version: row.version,
          kind: row.kind,
          image: row.image,
          port: row.port,
          builtin: row.builtin,
        })),
      );
    },
  });

  mcp.registerTool({
    name: "get_service",
    scope: "agents:read",
    description:
      "One catalog entry in full, including the variables (testEnv) a run's shells receive — the contract a repository's tests rely on.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version"],
      properties: keyJsonSchema,
    },
    handler: async (rawArgs: unknown, ctx) => {
      const key = parse(KeySchema, "get_service arguments", rawArgs);
      return textResult(view(await findEntry(ctx, key)));
    },
  });

  mcp.registerTool({
    name: "create_service",
    scope: "services:manage",
    description:
      "Service managers (services:manage): add a catalog entry repositories can then declare in .wardby/services.yaml. The image must be pinned by digest; kind is sidecar (a fresh instance in each run's pod).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version", "image", "port", "readiness", "resources", "dataPath"],
      // kind is checked by the zod schema (only "sidecar" today), so a refusal names the field.
      properties: { ...definitionProperties, kind: { type: "string", description: 'Only "sidecar" today.' } },
    },
    handler: async (rawArgs: unknown, ctx) => {
      const definition = parse(CodingServiceDefinitionSchema, "create_service arguments", rawArgs);
      const key = { name: definition.name, version: definition.version };
      if (await ctx.db.codingService.findUnique({ where: { name_version: key } })) {
        throw new McpError(
          409,
          `The catalog already has "${key.name} ${key.version}"; use update_service to change it.`,
        );
      }
      const row = await ctx.db.codingService.create({
        data: { ...definition, builtin: false, createdById: ctx.principal.id },
      });
      audit(ctx, "create", definition);
      return textResult(view(row));
    },
  });

  mcp.registerTool({
    name: "update_service",
    scope: "services:manage",
    description:
      "Service managers (services:manage): change a non-built-in catalog entry (name and version identify it and never change). Runs already dispatched keep the entry they started with.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version"],
      properties: definitionProperties,
    },
    handler: async (rawArgs: unknown, ctx) => {
      const { name, version, ...patch } = parse(UpdateSchema, "update_service arguments", rawArgs);
      const row = await findEntry(ctx, { name, version });
      if (row.builtin) throw refuseBuiltin({ name, version });
      const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      const next = parse(CodingServiceDefinitionSchema, "coding service", { ...catalogEntryFromRow(row), ...changes });
      const { name: _name, version: _version, kind: _kind, ...fields } = next;
      const updated = await ctx.db.codingService.update({ where: { name_version: { name, version } }, data: fields });
      audit(ctx, "update", next);
      return textResult(view(updated));
    },
  });

  mcp.registerTool({
    name: "delete_service",
    scope: "services:manage",
    description:
      "Service managers (services:manage): remove a non-built-in catalog entry. Repositories still declaring it are refused at their next run (service_unknown).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version"],
      properties: keyJsonSchema,
    },
    handler: async (rawArgs: unknown, ctx) => {
      const key = parse(KeySchema, "delete_service arguments", rawArgs);
      const row = await findEntry(ctx, key);
      if (row.builtin) throw refuseBuiltin(key);
      await ctx.db.codingService.delete({ where: { name_version: key } });
      audit(ctx, "delete", key);
      return textResult({ deleted: key });
    },
  });
}
