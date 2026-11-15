/**
 * The agent fingerprint a retained sandbox (WorkspaceJobLauncher.retain) and a continuation's
 * JobSpec.warm carry: a continuation adopts the previous round's sandbox only when both name the
 * same agent, provider, model, images, resource limits, system prompt and repository. Every input
 * is a value the run was launched with (the run's resolved job spec), so a change to any of them
 * between rounds starts the next round fresh (`fingerprint_changed`).
 *
 * SHA-256 hex (WARM_FINGERPRINT) over the canonical JSON of exactly these fields: object keys
 * sorted, no whitespace. The fingerprint is not secret, but it is never logged or published either
 * (only compared); the system prompt goes in as its own SHA-256, never as text.
 */
import { createHash } from "node:crypto";

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
  };
  return sha256(canonicalJson(fields));
}
