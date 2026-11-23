/**
 * Dispatch-time resolution (docs/coding-services.md): each service the
 * repository declares must exist in the catalog, as that exact version, be
 * declared under the key its kind belongs to (a toolchain under `toolchain:`, a
 * sidecar or docker service under `services:`, a setup job under `setup:`),
 * and the agent must be allowed its name (one list, codingProfile.services, for
 * every kind); a run has at most one docker service, and every service a setup
 * job waits for must be declared under `services:`. The first failure refuses
 * the whole run with its host sentence; otherwise every entry is snapshotted
 * for the run in declaration order: the toolchain first, then the services,
 * then the setup jobs in the order they run.
 *
 * The task text is also checked here: the agent's instructions plus the note
 * these services would add (servicesInstructionNote) plus the request must
 * still fit MAX_CODING_TASK_BYTES (composeCodingTask enforces this), or the run
 * is refused rather than left to fail later with a generic size error.
 */
import { composeCodingTask } from "../protocol.js";
import {
  catalogEntryFromRow,
  MAX_DOCKER_SERVICES,
  resolvedFromDefinition,
  type CodingServiceRow,
  type ResolvedCodingService,
} from "./catalog.js";
import { declaredEntries, type ServiceDeclaration } from "./declaration.js";
import { servicesInstructionNote } from "./note.js";
import {
  misplacedServiceSentence,
  notAllowedServiceSentence,
  serviceRefusal,
  SERVICE_INSTRUCTIONS_TOO_LARGE_SENTENCE,
  setupWaitForSentence,
  TOO_MANY_DOCKER_SERVICES_SENTENCE,
  unknownServiceSentence,
} from "./wording.js";

/** The one catalog query resolution needs (a Prisma `codingService` delegate satisfies it through a lambda). */
export interface CodingServiceCatalogReader {
  findMany(args: { where: { OR: Array<{ name: string; version: string }> } }): Promise<CodingServiceRow[]>;
}

export type ServiceResolution = { services: ResolvedCodingService[] } | { refusal: string };

const keyOf = (service: { name: string; version: string }): string => `${service.name}\u0000${service.version}`;

/**
 * `task` is the run's request text and `instructions` the agent's standing
 * instructions — exactly what dispatch passes to composeCodingTask — so a
 * services note that pushes the composed task over the byte limit is refused
 * here rather than surfacing as a generic composeCodingTask error at dispatch.
 */
export async function resolveRunServices(
  catalog: CodingServiceCatalogReader,
  declaration: ServiceDeclaration,
  allowed: readonly string[],
  task: string,
  instructions?: string | null,
): Promise<ServiceResolution> {
  const declared = declaredEntries(declaration);
  if (declared.length === 0) return { services: [] };
  const rows = await catalog.findMany({ where: { OR: declared.map(({ name, version }) => ({ name, version })) } });
  const entries = new Map(rows.map((row) => [keyOf(row), catalogEntryFromRow(row)]));
  const rowsByKey = new Map(rows.map((row) => [keyOf(row), row]));
  for (const service of declared) {
    if (!entries.has(keyOf(service))) {
      return { refusal: serviceRefusal("service_unknown", unknownServiceSentence(service.name, service.version)) };
    }
  }
  const setupJobs = new Set(declaration.setup ?? []);
  for (const service of declared) {
    const kind = entries.get(keyOf(service))!.kind;
    const declaredUnder =
      service === declaration.toolchain ? "toolchain" : setupJobs.has(service) ? "setup" : "services";
    const belongsUnder = kind === "sidecar" || kind === "docker" ? "services" : kind;
    if (belongsUnder !== declaredUnder) {
      return {
        refusal: serviceRefusal(
          "service_declaration_invalid",
          misplacedServiceSentence(service.name, kind === "docker" ? "sidecar" : kind, declaredUnder),
        ),
      };
    }
  }
  const allowedNames = new Set(allowed);
  for (const service of declared) {
    if (!allowedNames.has(service.name)) {
      return { refusal: serviceRefusal("service_not_allowed", notAllowedServiceSentence(service.name)) };
    }
  }
  // After the allow check, so a host sentence names a catalog entry's dependencies only for jobs this agent may run.
  const declaredServices = new Set(declaration.services.map((service) => service.name));
  for (const job of declaration.setup ?? []) {
    const entry = entries.get(keyOf(job))!;
    const missing = entry.kind === "setup" ? entry.waitFor.find((name) => !declaredServices.has(name)) : undefined;
    if (missing !== undefined) {
      return { refusal: serviceRefusal("service_declaration_invalid", setupWaitForSentence(job.name, missing)) };
    }
  }
  const services = declared.map((service) => {
    const row = rowsByKey.get(keyOf(service))!;
    return resolvedFromDefinition(entries.get(keyOf(service))!, { id: row.id, updatedAt: row.updatedAt });
  });
  if (services.filter((service) => service.kind === "docker").length > MAX_DOCKER_SERVICES) {
    return { refusal: serviceRefusal("service_declaration_invalid", TOO_MANY_DOCKER_SERVICES_SENTENCE) };
  }
  const note = servicesInstructionNote(services);
  if (note !== undefined) {
    try {
      composeCodingTask(instructions, task, note);
    } catch {
      return { refusal: serviceRefusal("service_declaration_invalid", SERVICE_INSTRUCTIONS_TOO_LARGE_SENTENCE) };
    }
  }
  return { services };
}
