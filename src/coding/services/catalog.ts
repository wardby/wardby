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
  MAX_SETUP_JOBS,
} from "../protocol.js";

/**
 * CODING_SERVICE_KINDS: "sidecar", a fresh instance in each run's pod; "toolchain", a team's own dev
 * image that the run's commands are forwarded to (wardby-cmd), sharing the run's /workspace (a run
 * has at most one); "docker", a rootless Docker daemon in each run's pod (Kubernetes with gVisor
 * only), whose socket the agent's shells use, and wardby owns everything about it but the image and
 * resources; "setup", a one-off job (a database migration, seed data) run after the run's services
 * are ready and before its agent starts, reading the checkout read-only (#589). "external" is
 * reserved for shared services reached through the proxy.
 */
export const CODING_SERVICE_KINDS = ["sidecar", "toolchain", "docker", "setup"] as const;
export type CodingServiceKind = (typeof CODING_SERVICE_KINDS)[number];
/**
 * Where a docker service's daemon listens: a directory outside /run and /etc (rootlesskit copies
 * those up into its own namespace, which would hide a socket there from other containers), on a
 * memory-backed volume the agent's shells (and a toolchain, when the run has one) mount too.
 */
export const DOCKER_SOCKET_DIR = "/wardby/docker";
export const DOCKER_SOCKET_PATH = `${DOCKER_SOCKET_DIR}/docker.sock`;
/** A docker service's testEnv, fixed by wardby: the docker CLI in the agent's shells reaches the daemon through it. */
export const DOCKER_TEST_ENV: Readonly<Record<string, string>> = Object.freeze({
  DOCKER_HOST: `unix://${DOCKER_SOCKET_PATH}`,
});
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
const onlyForSetup = z.undefined({ error: "is only for a setup job" }).optional();
const notForSetup = z.undefined({ error: "is not used by a setup job" }).optional();

/** How many services one setup job may wait for. */
export const MAX_SETUP_WAIT_FOR = 8;
/** A setup job's timeoutSeconds bounds and default. */
export const MAX_SETUP_TIMEOUT_SECONDS = 3600;
export const DEFAULT_SETUP_TIMEOUT_SECONDS = 600;

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
  command: onlyForSetup,
  waitFor: onlyForSetup,
  timeoutSeconds: onlyForSetup,
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
  command: onlyForSetup,
  waitFor: onlyForSetup,
  timeoutSeconds: onlyForSetup,
};

const setupFields = {
  ...commonFields,
  kind: z.literal("setup"),
  /**
   * The argv the job runs (cwd /workspace, the checkout mounted read-only), through the command
   * agent, so the image needs no shell; a non-zero exit fails the run before its agent starts. Same
   * bounds as startCommand.
   */
  command: commandSchema,
  /** The services the job needs: each must be declared in the run under `services:` (checked at dispatch). */
  waitFor: z
    .array(codingServiceNameSchema)
    .min(1)
    .max(MAX_SETUP_WAIT_FOR)
    .refine((names) => new Set(names).size === names.length, "must not repeat a name"),
  timeoutSeconds: z.number().int().min(1).max(MAX_SETUP_TIMEOUT_SECONDS).default(DEFAULT_SETUP_TIMEOUT_SECONDS),
  /** A setup job hands the agent's shells nothing: only an empty object (a row's column default) is accepted. */
  testEnv: z
    .record(z.string(), z.string())
    .refine((env) => Object.keys(env).length === 0, "is not used by a setup job")
    .default({}),
  // Substrate does not run setup jobs yet (setup_unsupported), so there is no Substrate image to name.
  substrateImage: notForSetup,
  port: notForSetup,
  readiness: notForSetup,
  startCommand: notForSetup,
  setupCommand: notForSetup,
  hostAliases: notForSetup,
  dataPath: notForSetup,
};

/**
 * A docker entry's fields: only its key, image and resources come from the catalog. Strict where it
 * is used, so a port, environment, probe or path from anywhere fails closed rather than reaching the
 * daemon.
 */
const dockerFields = {
  name: codingServiceNameSchema,
  version: codingServiceVersionSchema,
  image: imageDigestSchema,
  resources: CodingServiceResourcesSchema,
  kind: z.literal("docker"),
};

/**
 * Directories a toolchain container's launcher mounts itself (the shared workspace, the command
 * agent's directory, HOME, wardby's run inputs): a writable path may not be or nest with one. A
 * setup job's container mounts the same directories, so the same paths are reserved there.
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

/**
 * A toolchain's or setup job's writable paths are emptyDirs too, and stay clear of the directories
 * its launcher mounts.
 */
function checkReservedMounts(where: string) {
  return (value: { writablePaths: string[] }, ctx: z.RefinementCtx): void => {
    checkMounts(value.writablePaths, ctx);
    for (const path of value.writablePaths) {
      const reserved = TOOLCHAIN_RESERVED_PATHS.find((root) => overlaps(path, root));
      if (reserved !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["writablePaths"],
          message: `${path} overlaps ${reserved}, which wardby mounts in ${where}`,
        });
      }
    }
  };
}
const checkToolchain = checkReservedMounts("a toolchain");
const checkSetup = checkReservedMounts("a setup job");

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
    z.object({ ...dockerFields, ...snapshotFields }).strict(),
    z
      .object({ ...setupFields, ...snapshotFields })
      .strict()
      .superRefine(checkSetup),
  ]),
);

/** A catalog entry, as create_service takes it and the CodingService table holds it (kind defaults to sidecar). */
export const CodingServiceDefinitionSchema = z.preprocess(
  defaultKind,
  z.discriminatedUnion("kind", [
    z.object(sidecarFields).strict().superRefine(checkSidecar),
    z.object(toolchainFields).strict().superRefine(checkToolchain),
    z.object(dockerFields).strict(),
    z.object(setupFields).strict().superRefine(checkSetup),
  ]),
);

export type ResolvedCodingService = z.output<typeof ResolvedCodingServiceSchema>;
export type ResolvedSidecarService = Extract<ResolvedCodingService, { kind: "sidecar" }>;
export type ResolvedToolchainService = Extract<ResolvedCodingService, { kind: "toolchain" }>;
export type ResolvedDockerService = Extract<ResolvedCodingService, { kind: "docker" }>;
export type ResolvedSetupService = Extract<ResolvedCodingService, { kind: "setup" }>;
/** What every launcher path that predates the docker kind handles: a sidecar or a toolchain. */
export type SidecarOrToolchainService = ResolvedSidecarService | ResolvedToolchainService;
/**
 * An entry that runs beside the run for its whole length (a sidecar, the toolchain or the docker
 * service): never a setup job.
 */
export type ResolvedRunningService = SidecarOrToolchainService | ResolvedDockerService;
export type CodingServiceDefinition = z.output<typeof CodingServiceDefinitionSchema>;
export type CodingSidecarDefinition = Extract<CodingServiceDefinition, { kind: "sidecar" }>;
export type CodingToolchainDefinition = Extract<CodingServiceDefinition, { kind: "toolchain" }>;
export type CodingDockerDefinition = Extract<CodingServiceDefinition, { kind: "docker" }>;
export type CodingSetupDefinition = Extract<CodingServiceDefinition, { kind: "setup" }>;

export function isSidecarService(service: ResolvedCodingService): service is ResolvedSidecarService {
  return service.kind === "sidecar";
}

export function isToolchainService(service: ResolvedCodingService): service is ResolvedToolchainService {
  return service.kind === "toolchain";
}

export function isDockerService(service: ResolvedCodingService): service is ResolvedDockerService {
  return service.kind === "docker";
}

export function isSetupService(service: ResolvedCodingService): service is ResolvedSetupService {
  return service.kind === "setup";
}

/**
 * A sidecar-only step's guard. Throws "coding_service_toolchain_unsupported" for a toolchain,
 * "coding_service_setup_unsupported" for a setup job, and "coding_service_kind_unsupported" for a
 * docker service: a launcher path that has no handling for a kind must never quietly treat one as a
 * sidecar or skip it.
 */
export function sidecarOnly(service: ResolvedCodingService): ResolvedSidecarService {
  if (service.kind === "toolchain") throw new Error("coding_service_toolchain_unsupported");
  if (service.kind === "setup") throw new Error("coding_service_setup_unsupported");
  if (service.kind !== "sidecar") throw new Error("coding_service_kind_unsupported");
  return service;
}

/** The run's toolchain, if it has one (resolution allows at most one). */
export function runToolchain(services: readonly ResolvedCodingService[]): ResolvedToolchainService | undefined {
  return services.find(isToolchainService);
}

/** The run's setup jobs, in declaration order: the order they run in, one at a time. */
export function runSetupJobs(services: readonly ResolvedCodingService[]): ResolvedSetupService[] {
  return services.filter(isSetupService);
}

/**
 * The entries that run beside the run for its whole length (its sidecars, toolchain and docker
 * service), in order: every entry but its setup jobs, which run once and get containers of their own.
 * Keeps the input's narrower type, so a list that has been through withoutDockerServices comes back
 * as sidecars and the toolchain only.
 */
export function runningServices<Service extends ResolvedCodingService>(
  services: readonly Service[],
): Array<Exclude<Service, ResolvedSetupService>> {
  return services.filter((service): service is Exclude<Service, ResolvedSetupService> => service.kind !== "setup");
}

/** Every kind but docker: what a launcher path that never starts a docker service is handed. */
export type NonDockerService = Exclude<ResolvedCodingService, ResolvedDockerService>;

/**
 * A launcher path's guard where the docker kind is never started (Docker, Substrate): throws
 * `error` for a docker service, as the backstop to dispatch's service_kind_unsupported refusal.
 * Setup jobs pass through untouched (never refused here, never treated as sidecars): the launcher
 * runs them itself (runSetupJobs) or refuses them as setup_unsupported, and runningServices on the
 * result gives the sidecars and toolchain alone.
 */
export function withoutDockerServices(services: readonly ResolvedCodingService[], error: string): NonDockerService[] {
  const started = services.filter((service): service is NonDockerService => service.kind !== "docker");
  if (started.length !== services.length) throw new Error(error);
  return started;
}

/** The run's docker service, if it has one (a run has at most one). */
export function runDockerService(services: readonly ResolvedCodingService[]): ResolvedDockerService | undefined {
  return services.find(isDockerService);
}

/**
 * The first of a run's docker services a launcher does not start (`supportsKind` is its
 * supportsServiceKind hook, or an executor's), or undefined. A hook that is absent or answers
 * undefined starts no docker service, so a launcher that predates the kind never receives one.
 * Sidecars, toolchains and setup jobs are not asked here: whether a launcher starts those is its
 * supportsServicesFor and unstartableServices answer (service_launcher_unsupported, setup_unsupported).
 */
export function unsupportedKindService(
  services: readonly ResolvedCodingService[],
  supportsKind: (kind: CodingServiceKind) => boolean | undefined,
): ResolvedCodingService | undefined {
  return services.find((service) => service.kind === "docker" && supportsKind(service.kind) !== true);
}

/** The variables a service hands the agent's shells: its catalog testEnv, or a docker service's fixed DOCKER_HOST. */
export function serviceTestEnv(service: ResolvedCodingService): Record<string, string> {
  return service.kind === "docker" ? { ...DOCKER_TEST_ENV } : service.testEnv;
}

/** A run has at most one docker service: its daemon's socket and volumes have fixed paths and names. */
export const MAX_DOCKER_SERVICES = 1;

/**
 * A run's snapshot: at most MAX_CODING_SERVICES running services (sidecars, toolchain and docker),
 * plus at most MAX_SETUP_JOBS setup jobs, and at most MAX_DOCKER_SERVICES docker services.
 */
export const StoredCodingServicesSchema = z
  .array(ResolvedCodingServiceSchema)
  .max(MAX_CODING_SERVICES + MAX_SETUP_JOBS)
  .refine(
    (services) =>
      runSetupJobs(services).length <= MAX_SETUP_JOBS && runningServices(services).length <= MAX_CODING_SERVICES,
    `must have at most ${MAX_CODING_SERVICES} services and ${MAX_SETUP_JOBS} setup jobs`,
  )
  .refine(
    (services) => services.filter((service) => service.kind === "docker").length <= MAX_DOCKER_SERVICES,
    `must have at most ${MAX_DOCKER_SERVICES} docker service`,
  );

/** The columns of a CodingService row the definition is read from. */
export interface CodingServiceRow {
  id?: string;
  updatedAt?: Date;
  name: string;
  version: string;
  kind: string;
  image: string;
  substrateImage?: string | null;
  /** Null for a toolchain, a setup job or a docker entry, as are readiness and dataPath. */
  port?: number | null;
  serviceEnv: unknown;
  testEnv: unknown;
  readiness?: unknown;
  startCommand: unknown;
  /** Toolchains only; null otherwise. Absent on reads from before toolchains. */
  setupCommand?: unknown;
  /** Toolchains only; null otherwise. Absent on reads from before host aliases. */
  hostAliases?: unknown;
  /** Setup jobs only (as are waitFor and timeoutSeconds); null otherwise. Absent on reads from before setup jobs. */
  command?: unknown;
  waitFor?: unknown;
  timeoutSeconds?: number | null;
  resources: unknown;
  dataPath?: string | null;
  writablePaths: unknown;
}

/** A row's nullable column, left out when null (a toolchain has no port, readiness or data path). */
function column<Key extends string>(key: Key, value: unknown): Partial<Record<Key, unknown>> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Record<Key, unknown>);
}

/**
 * A row as its definition. Throws when the row was edited out of shape (the operator log keeps the name).
 * A docker row is read from its key, image and resources only: its other columns are never read, so
 * nothing in them reaches the daemon.
 */
export function catalogEntryFromRow(row: CodingServiceRow): CodingServiceDefinition {
  if (row.kind === "docker") {
    const parsed = CodingServiceDefinitionSchema.safeParse({
      name: row.name,
      version: row.version,
      kind: row.kind,
      image: row.image,
      resources: row.resources,
    });
    if (!parsed.success) throw new Error(`coding_service_catalog_invalid:${row.name} ${row.version}`);
    return parsed.data;
  }
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
    ...column("command", row.command),
    ...column("waitFor", row.waitFor),
    ...column("timeoutSeconds", row.timeoutSeconds),
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
  definition: CodingDockerDefinition,
  catalog?: { id?: string; updatedAt?: Date },
): ResolvedDockerService;
export function resolvedFromDefinition(
  definition: CodingSetupDefinition,
  catalog?: { id?: string; updatedAt?: Date },
): ResolvedSetupService;
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
export function substrateServiceImage(service: SidecarOrToolchainService): string {
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
 * image must match exactly, is unchanged by toolchains (#599). A docker service hands over its fixed
 * DOCKER_HOST. Setup jobs are left out: they hand the shells no variables and are finished before
 * the worker starts (#589).
 */
export function workerServices(
  services: readonly ResolvedCodingService[],
): Array<{ name: string; version: string; testEnv: Record<string, string> }> {
  return runningServices(services).map((service) => ({
    name: service.name,
    version: service.version,
    testEnv: serviceTestEnv(service),
  }));
}
