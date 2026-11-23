/**
 * The agent fingerprint a retained sandbox (WorkspaceJobLauncher.retain) and a continuation's
 * JobSpec.warm carry: a continuation adopts the previous round's sandbox only when both name the
 * same agent, provider, model, images, resource limits, system prompt, repository and secrets. Every
 * input is a value the run was launched with (the run's resolved job spec), so a change to any of
 * them between rounds starts the next round fresh (`fingerprint_changed`).
 *
 * Secrets go in as identity and version only (WarmSecretVersion: the secret's id, the name it is
 * delivered under, its updatedAt): NEVER a value or a hash of one. A kept round's session holds
 * whatever values it saw, and the next round's transcript is redacted against the values current
 * then, so a secret rotated, re-connected, re-brokered, attached or detached between rounds must
 * start the next round fresh.
 *
 * The run's MCP tool pins go in as identity only (which tool of which server, never its definition),
 * and only when the run has some, so a fingerprint without them is unchanged.
 *
 * The run's services go in as one hash of their identity and version (name, version, image digest,
 * Substrate image digest and start command when set, port, data path, the env KEY names, the catalog row's id and updatedAt): never an env value, since
 * catalog env values can be secrets. Only when the run has some, so a fingerprint without them is
 * unchanged.
 *
 * SHA-256 hex (WARM_FINGERPRINT) over the canonical JSON of exactly these fields: object keys
 * sorted, no whitespace. The fingerprint is not secret, but it is never logged or published either
 * (only compared); the system prompt goes in as its own SHA-256, never as text.
 */
import { createHash } from "node:crypto";
import type { ResolvedCodingService } from "../../coding/services/catalog.js";

/** One secret delivered to the run (to its redaction set): identity and version, never its value. */
export interface WarmSecretVersion {
  /** Secret.id. */
  id: string;
  /** The name it is delivered under: the attachment's bound name, or `mcp:<server>/<secret>`. */
  name: string;
  /** Secret.updatedAt, ISO 8601: changes with every value, broker or OAuth change. */
  updatedAt: string;
}

/** One pinned MCP tool, as the fingerprint sees it: which tool of which server (no definition). */
export interface WarmMcpToolPin {
  serverId: string;
  exposedName: string;
}

export interface WarmFingerprintInput {
  agentId: string;
  provider: string;
  model: string;
  workerImage: string;
  toolImage: string;
  cpu: number;
  memoryMb: number;
  diskMb: number;
  /** SHA-256 hex of the agent's system prompt (systemPromptSha256). */
  systemPromptSha256: string;
  repository: string;
  /** Every secret delivered to the run, in any order (sorted here). */
  secrets: readonly WarmSecretVersion[];
  /** The run's MCP tool pins, in any order (sorted here). Absent or empty: left out, so the fingerprint is today's. */
  mcpTools?: readonly WarmMcpToolPin[];
  /** servicesFingerprint(the run's resolved services); absent for a run without any, so its fingerprint is today's. */
  services?: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** SHA-256 hex of a system prompt, for WarmFingerprintInput.systemPromptSha256. */
export function systemPromptSha256(systemPrompt: string): string {
  return sha256(systemPrompt);
}

/** JSON with every object's keys sorted, recursively, and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * SHA-256 hex of canonicalJson(the resolved entries sorted by name, then version), or undefined for
 * none. Identity of what the run's holder starts; never logged (only compared, inside the fingerprint).
 */
export function servicesFingerprint(services: readonly ResolvedCodingService[] | undefined): string | undefined {
  if (!services || services.length === 0) return undefined;
  const sorted = [...services].sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version));
  return sha256(
    canonicalJson(
      sorted.map((service) => ({
        name: service.name,
        version: service.version,
        image: service.image,
        // Only when set, so an entry without one keeps its fingerprint.
        ...(service.substrateImage === undefined ? {} : { substrateImage: service.substrateImage }),
        // The start command (catalog, not secret: env goes in by name) changes what the holder runs.
        ...(service.startCommand === undefined ? {} : { startCommand: service.startCommand }),
        // A sidecar keeps its fields (and so its fingerprint); a toolchain has kind and setupCommand
        // instead, and a setup job (#589) kind, its command, what it waits for and its timeout.
        ...(service.kind === "toolchain"
          ? {
              kind: service.kind,
              ...(service.setupCommand === undefined ? {} : { setupCommand: service.setupCommand }),
            }
          : service.kind === "setup"
            ? {
                kind: service.kind,
                command: service.command,
                waitFor: service.waitFor,
                timeoutSeconds: service.timeoutSeconds,
              }
            : { port: service.port, dataPath: service.dataPath }),
        serviceEnvKeys: Object.keys(service.serviceEnv).sort(),
        testEnvKeys: Object.keys(service.testEnv).sort(),
        catalogId: service.catalogId ?? null,
        catalogUpdatedAt: service.catalogUpdatedAt ?? null,
      })),
    ),
  );
}

/** The fingerprint of `input`'s fields (and only those): 64 lowercase hex characters. */
export function warmFingerprint(input: WarmFingerprintInput): string {
  const fields: WarmFingerprintInput = {
    agentId: input.agentId,
    provider: input.provider,
    model: input.model,
    workerImage: input.workerImage,
    toolImage: input.toolImage,
    cpu: input.cpu,
    memoryMb: input.memoryMb,
    diskMb: input.diskMb,
    systemPromptSha256: input.systemPromptSha256,
    repository: input.repository,
    secrets: [...input.secrets]
      .map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))
      .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id) || compare(a.updatedAt, b.updatedAt)),
    ...(input.mcpTools && input.mcpTools.length > 0
      ? {
          mcpTools: input.mcpTools
            .map(({ serverId, exposedName }) => ({ serverId, exposedName }))
            .sort((a, b) => compare(a.exposedName, b.exposedName) || compare(a.serverId, b.serverId)),
        }
      : {}),
    ...(input.services ? { services: input.services } : {}),
  };
  return sha256(canonicalJson(fields));
}
