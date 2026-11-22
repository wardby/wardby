/**
 * The coding-run service catalog (docs/coding-services.md): what a repository's
 * .wardby/services.yaml may name. An entry is admin-managed, trusted data: a
 * digest-pinned image, the environment it starts with, the variables it hands
 * the agent's shells, how to tell it is ready, and what it may use. Repository
 * content only ever names an entry; it never supplies any of these.
 */
import { z } from "zod";
import { isRepositoryDigest } from "../../providers/jobs/docker-isolation.js";
import {
  byteLength,
  CODING_SERVICE_NAME,
  CODING_SERVICE_VERSION,
  CodingServiceTestEnvSchema,
  INVALID_SINGLE_LINE_CONTROL,
  MAX_CODING_SERVICES,
} from "../protocol.js";

/**
 * CODING_SERVICE_KINDS: "sidecar", a fresh instance in each run's pod; "toolchain", a team's own dev
 * image that the run's commands are forwarded to (wardby-cmd), sharing the run's /workspace (a run
 * has at most one). "external" is reserved for shared services reached through the proxy.
 */
export const CODING_SERVICE_KINDS = ["sidecar", "toolchain"] as const;
export type CodingServiceKind = (typeof CODING_SERVICE_KINDS)[number];
/** How many service names one agent may be allowed. */
export const MAX_AGENT_SERVICES = 16;
export const MAX_SERVICE_ENV = 32;
const MAX_WRITABLE_PATHS = 4;
const MAX_PATH_BYTES = 255;
const SERVICE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ABSOLUTE_PATH = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const FORBIDDEN_ROOTS = ["/proc", "/sys", "/dev"];
/** One startCommand argument's largest size: room for a `/bin/sh -c` start script (one line). */
export const MAX_START_ARG_BYTES = 4096;

const singleLine = (max: number) =>
  z
    .string()
    .refine(
      (value) => byteLength(value) <= max && !INVALID_SINGLE_LINE_CONTROL.test(value),
      `must be one line of at most ${max} bytes`,
    );

export const codingServiceNameSchema = z
  .string()
  .regex(CODING_SERVICE_NAME, "must be lowercase letters, digits and hyphens, starting with a letter (at most 40)");
export const codingServiceVersionSchema = z
  .string()
  .regex(CODING_SERVICE_VERSION, 'must be a short version such as "16" (letters, digits, ".", "_", "-"; at most 20)');

const serviceEnvSchema = z.record(z.string(), singleLine(1024)).superRefine((env, ctx) => {
  const names = Object.keys(env);
  if (names.length > MAX_SERVICE_ENV) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must have at most ${MAX_SERVICE_ENV} variables` });
  }
  for (const name of names) {
    if (!SERVICE_ENV_NAME.test(name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: "must be a variable name" });
    }
  }
});

const pathSchema = z
  .string()
  .refine(
    (value) =>
      ABSOLUTE_PATH.test(value) &&
      byteLength(value) <= MAX_PATH_BYTES &&
      !value.split("/").some((part) => part === "." || part === "..") &&
      !FORBIDDEN_ROOTS.some((root) => value === root || value.startsWith(`${root}/`)),
    "must be an absolute path outside /proc, /sys and /dev, without . or .. components",
  );

export const CodingServiceReadinessSchema = z
  .object({
    command: z
      .array(singleLine(256).refine((value) => value.length > 0, "must not be empty"))
      .min(1)
      .max(16),
    periodSeconds: z.number().int().min(1).max(60),
    timeoutSeconds: z.number().int().min(1).max(60),
    failureThreshold: z.number().int().min(1).max(120),
  })
  .strict();

export const CodingServiceResourcesSchema = z
  .object({
    cpuMillicores: z.number().int().min(100).max(4000),
    memoryMib: z.number().int().min(64).max(16_384),
    diskMib: z.number().int().min(64).max(8192),
  })
  .strict();

const imageDigestSchema = z
  .string()
  .max(512)
  .refine(isRepositoryDigest, "must be a registry digest (repo@sha256:<64 hex>)");

/** An argv of 1 to 16 non-empty arguments, each one line of at most MAX_START_ARG_BYTES. */
const commandSchema = z
  .array(singleLine(MAX_START_ARG_BYTES).refine((value) => value.length > 0, "must not be empty"))
  .min(1)
  .max(16);

/** Fields every kind has. */
const commonFields = {
  name: codingServiceNameSchema,
  version: codingServiceVersionSchema,
  image: imageDigestSchema,
  /**
   * The image the Substrate launcher runs instead of `image` (Docker and Kubernetes never read it):
   * for a service whose usual image cannot start there, as Substrate runs a service container as
   * the image's default user without the capabilities a chown/gosu entrypoint needs. A sidecar that
   * sets it also sets startCommand, since that image's own entrypoint is not used.
   */
  substrateImage: imageDigestSchema.optional(),
  serviceEnv: serviceEnvSchema.default({}),
  testEnv: CodingServiceTestEnvSchema.default({}),
  resources: CodingServiceResourcesSchema,
  writablePaths: z.array(pathSchema).max(MAX_WRITABLE_PATHS).default([]),
};

const onlyForToolchain = z.undefined({ error: "is only for a toolchain" }).optional();

/** How many host names one toolchain entry may alias to the run's loopback. */
export const MAX_HOST_ALIASES = 16;
/** A lower-case host name: one or more DNS labels, at most 253 characters. */
const HOST_ALIAS = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/**
 * Host names a team's code hard-codes for its services (compose names such as `elastic`), resolved
 * to 127.0.0.1 in the run, where every service listens. Applied as real hosts entries by the
 * launcher: the team image's root filesystem is read-only, so it cannot add them itself.
 */
const hostAliasesSchema = z
  .array(
    z
      .string()
      .regex(HOST_ALIAS, "must be a lower-case host name")
      .refine((name) => name !== "localhost", "is already 127.0.0.1"),
  )
  .min(1)
  .max(MAX_HOST_ALIASES)
  .refine((names) => new Set(names).size === names.length, "must not repeat a name");
const notForToolchain = z.undefined({ error: "is not used by a toolchain" }).optional();

const sidecarFields = {
  ...commonFields,
  kind: z.literal("sidecar"),
  port: z.number().int().min(1).max(65_535),
  readiness: CodingServiceReadinessSchema,
  /**
   * The argv that starts the service on the Substrate launcher, which overrides the container's
   * command: the image's ENTRYPOINT + CMD, or for an entry with substrateImage, a script that
   * initialises and runs the service as that image's non-root user. Docker and Kubernetes run the
   * image's own entrypoint and ignore it. Each argument is one line of at most MAX_START_ARG_BYTES.
   */
  startCommand: commandSchema.optional(),
  dataPath: pathSchema,
  setupCommand: onlyForToolchain,
  hostAliases: onlyForToolchain,
};

const toolchainFields = {
  ...commonFields,
  kind: z.literal("toolchain"),
  /**
   * Run once in the toolchain container before any forwarded command (cwd /workspace), with the
   * container's environment; its output is never captured, only its exit code. Same bounds as
   * startCommand.
   */
  setupCommand: commandSchema.optional(),
  hostAliases: hostAliasesSchema.optional(),
  port: notForToolchain,
  readiness: notForToolchain,
  startCommand: notForToolchain,
  dataPath: notForToolchain,
};

/**
 * Directories a toolchain container's launcher mounts itself (the shared workspace, the command
 * agent's directory, HOME, wardby's run inputs): a writable path may not be or nest with one.
 */
export const TOOLCHAIN_RESERVED_PATHS = ["/workspace", "/opt/wardby-cmd", "/home/wardby", "/run/wardby"] as const;

const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

function checkMounts(paths: readonly string[], ctx: z.RefinementCtx): void {
  for (const [index, a] of paths.entries()) {
    for (const b of paths.slice(index + 1)) {
      if (overlaps(a, b)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["writablePaths"], message: `${a} and ${b} overlap` });
      }
    }
  }
}

/**
 * Every mount is its own emptyDir, so no two may be the same directory or nest; and a Substrate-only
 * image comes with the start command that replaces its entrypoint.
 */
function checkSidecar(
  value: { dataPath: string; writablePaths: string[]; substrateImage?: string; startCommand?: string[] },
  ctx: z.RefinementCtx,
): void {
  if (value.substrateImage !== undefined && value.startCommand === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["startCommand"],
      message: "is required with substrateImage (that image's own entrypoint is not used)",
    });
  }
  checkMounts([value.dataPath, ...value.writablePaths], ctx);
}

/** A toolchain's writable paths are emptyDirs too, and stay clear of the directories its launcher mounts. */
function checkToolchain(value: { writablePaths: string[] }, ctx: z.RefinementCtx): void {
  checkMounts(value.writablePaths, ctx);
  for (const path of value.writablePaths) {
    const reserved = TOOLCHAIN_RESERVED_PATHS.find((root) => overlaps(path, root));
    if (reserved !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["writablePaths"],
        message: `${path} overlaps ${reserved}, which wardby mounts in a toolchain`,
      });
    }
  }
}

/** An entry without a kind (every snapshot and row from before toolchains) is a sidecar. */
function defaultKind(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return (value as { kind?: unknown }).kind === undefined ? { ...value, kind: "sidecar" } : value;
}

const snapshotFields = {
  /** The catalog row's id and updatedAt (ISO 8601) when the snapshot was taken: identity and version for the warm fingerprint. */
  catalogId: z.string().max(64).optional(),
  catalogUpdatedAt: z.string().max(40).optional(),
};

/** One run's snapshot of an entry: what dispatch stores on CodingRun.services and the launcher reads. */
export const ResolvedCodingServiceSchema = z.preprocess(
  defaultKind,
  z.discriminatedUnion("kind", [
    z
      .object({ ...sidecarFields, ...snapshotFields })
      .strict()
      .superRefine(checkSidecar),
    z
      .object({ ...toolchainFields, ...snapshotFields })
      .strict()
      .superRefine(checkToolchain),
  ]),
);

/** A catalog entry, as create_service takes it and the CodingService table holds it (kind defaults to sidecar). */
export const CodingServiceDefinitionSchema = z.preprocess(
  defaultKind,
  z.discriminatedUnion("kind", [
    z.object(sidecarFields).strict().superRefine(checkSidecar),
    z.object(toolchainFields).strict().superRefine(checkToolchain),
  ]),
);

export type ResolvedCodingService = z.output<typeof ResolvedCodingServiceSchema>;
export type ResolvedSidecarService = Extract<ResolvedCodingService, { kind: "sidecar" }>;
export type ResolvedToolchainService = Extract<ResolvedCodingService, { kind: "toolchain" }>;
export type CodingServiceDefinition = z.output<typeof CodingServiceDefinitionSchema>;
export type CodingSidecarDefinition = Extract<CodingServiceDefinition, { kind: "sidecar" }>;
export type CodingToolchainDefinition = Extract<CodingServiceDefinition, { kind: "toolchain" }>;

export function isSidecarService(service: ResolvedCodingService): service is ResolvedSidecarService {
  return service.kind === "sidecar";
}

export function isToolchainService(service: ResolvedCodingService): service is ResolvedToolchainService {
  return service.kind === "toolchain";
}

/**
 * A sidecar-only step's guard. Throws "coding_service_toolchain_unsupported" for a toolchain: a
 * launcher path that has no toolchain handling must never quietly treat one as a sidecar or skip it.
 */
export function sidecarOnly(service: ResolvedCodingService): ResolvedSidecarService {
  if (service.kind !== "sidecar") throw new Error("coding_service_toolchain_unsupported");
  return service;
}

/** The run's toolchain, if it has one (resolution allows at most one). */
export function runToolchain(services: readonly ResolvedCodingService[]): ResolvedToolchainService | undefined {
  return services.find(isToolchainService);
}

export const StoredCodingServicesSchema = z.array(ResolvedCodingServiceSchema).max(MAX_CODING_SERVICES);

/** The columns of a CodingService row the definition is read from. */
export interface CodingServiceRow {
  id?: string;
  updatedAt?: Date;
  name: string;
  version: string;
  kind: string;
  image: string;
  substrateImage?: string | null;
  /** Null for a toolchain, as are readiness and dataPath. */
  port?: number | null;
  serviceEnv: unknown;
  testEnv: unknown;
  readiness?: unknown;
  startCommand: unknown;
  /** Toolchains only; null otherwise. Absent on reads from before toolchains. */
  setupCommand?: unknown;
  /** Toolchains only; null otherwise. Absent on reads from before host aliases. */
  hostAliases?: unknown;
  resources: unknown;
  dataPath?: string | null;
  writablePaths: unknown;
}

/** A row's nullable column, left out when null (a toolchain has no port, readiness or data path). */
function column<Key extends string>(key: Key, value: unknown): Partial<Record<Key, unknown>> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Record<Key, unknown>);
}

/** A row as its definition. Throws when the row was edited out of shape (the operator log keeps the name). */
export function catalogEntryFromRow(row: CodingServiceRow): CodingServiceDefinition {
  const parsed = CodingServiceDefinitionSchema.safeParse({
    name: row.name,
    version: row.version,
    kind: row.kind,
    image: row.image,
    ...column("substrateImage", row.substrateImage),
    ...column("port", row.port),
    serviceEnv: row.serviceEnv,
    testEnv: row.testEnv,
    ...column("readiness", row.readiness),
    ...column("startCommand", row.startCommand),
    ...column("setupCommand", row.setupCommand),
    ...column("hostAliases", row.hostAliases),
    resources: row.resources,
    ...column("dataPath", row.dataPath),
    writablePaths: row.writablePaths,
  });
  if (!parsed.success) throw new Error(`coding_service_catalog_invalid:${row.name} ${row.version}`);
  return parsed.data;
}

/** The per-run snapshot of an entry, kind included. */
export function resolvedFromDefinition(
  definition: CodingSidecarDefinition,
  catalog?: { id?: string; updatedAt?: Date },
): ResolvedSidecarService;
export function resolvedFromDefinition(
  definition: CodingToolchainDefinition,
  catalog?: { id?: string; updatedAt?: Date },
): ResolvedToolchainService;
export function resolvedFromDefinition(
  definition: CodingServiceDefinition,
  catalog?: { id?: string; updatedAt?: Date },
): ResolvedCodingService;
export function resolvedFromDefinition(
  definition: CodingServiceDefinition,
  catalog?: { id?: string; updatedAt?: Date },
): ResolvedCodingService {
  return {
    ...definition,
    ...(catalog?.id === undefined ? {} : { catalogId: catalog.id }),
    ...(catalog?.updatedAt === undefined ? {} : { catalogUpdatedAt: catalog.updatedAt.toISOString() }),
  };
}

/** The image the Substrate launcher runs for a service: its substrateImage when set, else its image. */
export function substrateServiceImage(service: ResolvedCodingService): string {
  return service.substrateImage ?? service.image;
}

/** CodingRun.services, parsed; a run from before services existed has []. Throws on anything else. */
export function parseStoredServices(value: unknown): ResolvedCodingService[] {
  if (value === null || value === undefined) return [];
  return StoredCodingServicesSchema.parse(value);
}

function storedEntries(value: unknown): Array<{ name: string; version: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = entry && typeof entry === "object" ? (entry as { name?: unknown; version?: unknown }) : undefined;
    return typeof record?.name === "string" && CODING_SERVICE_NAME.test(record.name)
      ? [{ name: record.name, version: record.version }]
      : [];
  });
}

/** The service names in CodingRun.services, read leniently: for wording only, never for launching. */
export function storedServiceNames(value: unknown): string[] {
  return storedEntries(value).map((entry) => entry.name);
}

/** "postgres 16" for each service in CodingRun.services with a valid name and version, for get_run. */
export function storedServiceLabels(value: unknown): string[] {
  return storedEntries(value).flatMap((entry) =>
    typeof entry.version === "string" && CODING_SERVICE_VERSION.test(entry.version)
      ? [`${entry.name} ${entry.version}`]
      : [],
  );
}

/** CodingAgentProfile.services: the catalog names this agent's runs may start (any version the catalog has). */
export const AllowedServiceNamesSchema = z
  .array(codingServiceNameSchema)
  .max(MAX_AGENT_SERVICES)
  .transform((names) => [...new Set(names)]);

export function parseAllowedServiceNames(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  return AllowedServiceNamesSchema.parse(value);
}

/**
 * What the worker receives for each service (CodingTaskInput.services): never the image or the
 * service's own environment, and not its kind: the Claude tool runner learns of a toolchain from its
 * own setup (claude-tool-setup.ts), so the worker input format, which the published Codex driver
 * image must match exactly, is unchanged by toolchains (#599).
 */
export function workerServices(
  services: readonly ResolvedCodingService[],
): Array<{ name: string; version: string; testEnv: Record<string, string> }> {
  return services.map(({ name, version, testEnv }) => ({ name, version, testEnv }));
}
