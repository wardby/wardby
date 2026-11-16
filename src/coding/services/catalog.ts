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

/** "sidecar": a fresh instance in each run's pod. "external" is reserved for shared services reached through the proxy. */
export const CODING_SERVICE_KINDS = ["sidecar"] as const;
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

const serviceFields = {
  name: codingServiceNameSchema,
  version: codingServiceVersionSchema,
  image: imageDigestSchema,
  /**
   * The image the Substrate launcher runs instead of `image` (Docker and Kubernetes never read it):
   * for a service whose usual image cannot start there, as Substrate runs a service container as
   * the image's default user without the capabilities a chown/gosu entrypoint needs. An entry that
   * sets it also sets startCommand, since that image's own entrypoint is not used.
   */
  substrateImage: imageDigestSchema.optional(),
  port: z.number().int().min(1).max(65_535),
  serviceEnv: serviceEnvSchema.default({}),
  testEnv: CodingServiceTestEnvSchema.default({}),
  readiness: CodingServiceReadinessSchema,
  /**
   * The argv that starts the service on the Substrate launcher, which overrides the container's
   * command: the image's ENTRYPOINT + CMD, or for an entry with substrateImage, a script that
   * initialises and runs the service as that image's non-root user. Docker and Kubernetes run the
   * image's own entrypoint and ignore it. Each argument is one line of at most MAX_START_ARG_BYTES.
   */
  startCommand: z
    .array(singleLine(MAX_START_ARG_BYTES).refine((value) => value.length > 0, "must not be empty"))
    .min(1)
    .max(16)
    .optional(),
  resources: CodingServiceResourcesSchema,
  dataPath: pathSchema,
  writablePaths: z.array(pathSchema).max(MAX_WRITABLE_PATHS).default([]),
};

/**
 * Every mount is its own emptyDir, so no two may be the same directory or nest; and a Substrate-only
 * image comes with the start command that replaces its entrypoint.
 */
function checkEntry(
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
  const paths = [value.dataPath, ...value.writablePaths];
  for (const [index, a] of paths.entries()) {
    for (const b of paths.slice(index + 1)) {
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["writablePaths"], message: `${a} and ${b} overlap` });
      }
    }
  }
}

/** One run's snapshot of an entry: what dispatch stores on CodingRun.services and the launcher reads. */
export const ResolvedCodingServiceSchema = z
  .object({
    ...serviceFields,
    /** The catalog row's id and updatedAt (ISO 8601) when the snapshot was taken: identity and version for the warm fingerprint. */
    catalogId: z.string().max(64).optional(),
    catalogUpdatedAt: z.string().max(40).optional(),
  })
  .strict()
  .superRefine(checkEntry);

/** A catalog entry, as create_service takes it and the CodingService table holds it. */
export const CodingServiceDefinitionSchema = z
  .object({ ...serviceFields, kind: z.enum(CODING_SERVICE_KINDS).default("sidecar") })
  .strict()
  .superRefine(checkEntry);

export type ResolvedCodingService = z.output<typeof ResolvedCodingServiceSchema>;
export type CodingServiceDefinition = z.output<typeof CodingServiceDefinitionSchema>;

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
  port: number;
  serviceEnv: unknown;
  testEnv: unknown;
  readiness: unknown;
  startCommand: unknown;
  resources: unknown;
  dataPath: string;
  writablePaths: unknown;
}

/** A row as its definition. Throws when the row was edited out of shape (the operator log keeps the name). */
export function catalogEntryFromRow(row: CodingServiceRow): CodingServiceDefinition {
  const parsed = CodingServiceDefinitionSchema.safeParse({
    name: row.name,
    version: row.version,
    kind: row.kind,
    image: row.image,
    ...(row.substrateImage === null || row.substrateImage === undefined ? {} : { substrateImage: row.substrateImage }),
    port: row.port,
    serviceEnv: row.serviceEnv,
    testEnv: row.testEnv,
    readiness: row.readiness,
    ...(row.startCommand === null || row.startCommand === undefined ? {} : { startCommand: row.startCommand }),
    resources: row.resources,
    dataPath: row.dataPath,
    writablePaths: row.writablePaths,
  });
  if (!parsed.success) throw new Error(`coding_service_catalog_invalid:${row.name} ${row.version}`);
  return parsed.data;
}

/** The per-run snapshot of an entry. */
export function resolvedFromDefinition(
  definition: CodingServiceDefinition,
  catalog?: { id?: string; updatedAt?: Date },
): ResolvedCodingService {
  const { kind: _kind, ...service } = definition;
  return {
    ...service,
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

/** What the worker receives for each service (CodingTaskInput.services): never the image or the service's own environment. */
export function workerServices(
  services: readonly ResolvedCodingService[],
): Array<{ name: string; version: string; testEnv: Record<string, string> }> {
  return services.map(({ name, version, testEnv }) => ({ name, version, testEnv }));
}
