/**
 * MCP-layer errors that carry an HTTP status + WWW-Authenticate challenge —
 * the transport (Task 7) maps these to the actual HTTP response; JSON-RPC
 * dispatch (Task 6) maps them to a JSON-RPC error object. One error type
 * for both call sites avoids two parallel error hierarchies.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "#prisma";
import { isSerializationConflict } from "../core/dispatch.js";
import { logger } from "../core/logger.js";

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
 * - P2003 (foreign key) -> 409, worded for both directions: a delete blocked
 *   by a reference (ON DELETE RESTRICT), or an insert/update pointing at a
 *   row that no longer exists (e.g. attach_tool racing delete_tool).
 * - A serialization failure or deadlock in one of the Serializable
 *   transactions, in any of the shapes isSerializationConflict knows (P2034,
 *   a raw-statement P2010, or an unwrapped driver adapter error at COMMIT)
 *   -> 409 asking the client to retry.
 * - Any other Prisma client error -> a generic 500 carrying only a
 *   reference id. Its message ("Invalid `tx.tool.update()` invocation in
 *   /path/to/file.ts:…") can include server source paths and query detail,
 *   so it is logged here, under that id, and never sent.
 * - Anything else (an McpError, a plain Error) is returned unchanged for the
 *   caller to rethrow.
 */
export function mapPrismaError(err: unknown): unknown {
  if (isSerializationConflict(err)) {
    return new McpError(409, "A concurrent change conflicted with this one; retry the request.");
  }
  if (!isPrismaClientError(err)) return err;
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return internalDatabaseError(err);
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
    return new McpError(
      409,
      `The ${noun ?? "record"} conflicts with a related record: it is still referenced by another record, or refers to one that no longer exists.`,
    );
  }
  return internalDatabaseError(err);
}

function isPrismaClientError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "DriverAdapterError") ||
    err instanceof Prisma.PrismaClientKnownRequestError ||
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientValidationError ||
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientRustPanicError
  );
}

function internalDatabaseError(err: unknown): McpError {
  const reference = randomUUID();
  logger.error({ err, reference }, "database error in an MCP handler; the client sees only the reference");
  return new McpError(500, `Internal database error (reference: ${reference}).`);
}
