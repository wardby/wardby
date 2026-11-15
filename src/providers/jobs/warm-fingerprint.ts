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
 * SHA-256 hex (WARM_FINGERPRINT) over the canonical JSON of exactly these fields: object keys
 * sorted, no whitespace. The fingerprint is not secret, but it is never logged or published either
 * (only compared); the system prompt goes in as its own SHA-256, never as text.
 */
import { createHash } from "node:crypto";

/** One secret delivered to the run (to its redaction set): identity and version, never its value. */
export interface WarmSecretVersion {
  /** Secret.id. */
  id: string;
  /** The name it is delivered under: the attachment's bound name, or `mcp:<server>/<secret>`. */
  name: string;
  /** Secret.updatedAt, ISO 8601: changes with every value, broker or OAuth change. */
  updatedAt: string;
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
  };
  return sha256(canonicalJson(fields));
}
