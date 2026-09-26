/**
 * MCP-layer errors that carry an HTTP status + WWW-Authenticate challenge —
 * the transport (Task 7) maps these to the actual HTTP response; JSON-RPC
 * dispatch (Task 6) maps them to a JSON-RPC error object. One error type
 * for both call sites avoids two parallel error hierarchies.
 */
import { Prisma } from "#prisma";

export class McpError extends Error {
  readonly httpStatus: number;
  readonly wwwAuthenticate?: string;

  constructor(httpStatus: number, message: string, wwwAuthenticate?: string) {
    super(message);
    this.name = "McpError";
    this.httpStatus = httpStatus;
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

export function unauthorized(message: string, resourceMetadataUrl: string): McpError {
  return new McpError(401, message, `Bearer resource_metadata="${resourceMetadataUrl}"`);
}

export function insufficientScope(scopes: string[], resourceMetadataUrl: string): McpError {
  return new McpError(
    403,
    `Insufficient scope; this operation requires: ${scopes.join(" ")}`,
    `Bearer resource_metadata="${resourceMetadataUrl}", scope="${scopes.join(" ")}"`,
  );
}

/** "BudgetGroup" -> "budget group". */
function humanizeModel(modelName: string): string {
  return modelName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

function withArticle(noun: string): string {
  return `${/^[aeiou]/.test(noun) ? "An" : "A"} ${noun}`;
}

/**
 * The fields behind a P2002, from whichever shape reported them: a classic
 * `meta.target`, the driver adapter's `constraint.fields`, or -- what
 * @prisma/adapter-pg actually reports, since PostgreSQL always names the
 * violated constraint -- the index name, which follows Prisma's default
 * `<Model>_<field>[_<field>...]_key` naming for every @unique/@@unique in
 * schema.prisma. Pinned against a real database in
 * core/prisma-adapter.database.test.ts.
 */
function uniqueFields(meta: Record<string, unknown> | undefined, modelName: string | undefined): string[] {
  const target = meta?.target;
  if (Array.isArray(target) && target.every((t) => typeof t === "string")) return target;
  if (typeof target === "string") return [target];
  const adapterError = meta?.driverAdapterError as { cause?: { constraint?: unknown } } | undefined;
  const constraint = adapterError?.cause?.constraint as { fields?: unknown; index?: unknown } | undefined;
  if (Array.isArray(constraint?.fields) && constraint.fields.every((f) => typeof f === "string")) {
    return constraint.fields;
  }
  const index = constraint?.index;
  if (typeof index === "string" && modelName && index.startsWith(`${modelName}_`) && index.endsWith("_key")) {
    return index.slice(modelName.length + 1, -"_key".length).split("_");
  }
  return [];
}

/**
 * The one place a Prisma error becomes a client-facing McpError, applied at
 * both MCP dispatch sites (server.ts) so no handler leaks the raw
 * "Invalid `prisma.x.create()` invocation" text. A handler that already
 * maps an error to its own, more specific McpError keeps that message: an
 * McpError passes through here unchanged.
 *
 * - P2002 (unique violation) -> 409 naming the model and the unique fields.
 *   An `ownerId` component is described ("for this owner") rather than
 *   named, since per-owner uniques are the common case.
 * - P2003 (foreign key, e.g. an ON DELETE RESTRICT) -> 409 "still referenced".
 * - Anything else is returned unchanged for the caller to rethrow.
 */
export function mapPrismaError(err: unknown): unknown {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return err;
  const meta = err.meta;
  const modelName = typeof meta?.modelName === "string" ? meta.modelName : undefined;
  const noun = modelName ? humanizeModel(modelName) : undefined;
  if (err.code === "P2002") {
    const fields = uniqueFields(meta, modelName);
    const named = fields.filter((f) => f !== "ownerId");
    if (!noun || named.length === 0) return new McpError(409, "A record with those values already exists.");
    const scope = named.length < fields.length ? " for this owner" : "";
    return new McpError(409, `${withArticle(noun)} with that ${named.join(" and ")} already exists${scope}.`);
  }
  if (err.code === "P2003") {
    return new McpError(409, `The ${noun ?? "record"} is still referenced by other records.`);
  }
  return err;
}
