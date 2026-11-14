import { createHash } from "node:crypto";

const hex = (input: string, length: number): string =>
  createHash("sha256").update(input).digest("hex").slice(0, length);

/** Stable, label-safe token for a wardby run: "wr-" + 20 hex chars of sha256(runId). */
export function substrateRunToken(runId: string): string {
  return `wr-${hex(runId, 20)}`;
}

export function agentActorName(token: string): string {
  return `${token}-agent`;
}

export function toolActorName(token: string): string {
  return `${token}-tool`;
}

/**
 * The header the tool actor's egress rule fills with its actor JWT (`Bearer <jwt>`). Not
 * `Authorization`: package managers send their registry-only token there, and the gateway replaces
 * only a header the request already carries.
 */
export const TOOL_ACTOR_JWT_HEADER = "X-Wardby-Actor-Jwt";

export function toolActorSubject(atespace: string, token: string): string {
  return `actor/${atespace}/${toolActorName(token)}`;
}

/**
 * Template name derived from its content: `wardby-<role>-` + 16 hex chars. `variant` is a stable
 * digest of everything else in the template (env, worker selector), so two templates that differ
 * in any field never share a name.
 */
export function templateName(
  role: "agent" | "tool",
  image: string,
  cpuMillicores: number,
  memoryBytes: number,
  variant: string,
): string {
  return `wardby-${role}-${hex(`${role}|${image}|${cpuMillicores}|${memoryBytes}|${variant}`, 16)}`;
}

/** Blob keys for one run. The launch record lives in Postgres, not in the blob store. */
export const BLOB = {
  input: (t: string) => `substrate/runs/${t}/input.json`,
  toolSetup: (t: string) => `substrate/runs/${t}/tool-setup.json`,
  seed: (t: string) => `substrate/runs/${t}/seed.tar`,
  result: (t: string) => `substrate/runs/${t}/result.json`,
  transcript: (t: string) => `substrate/runs/${t}/transcript.jsonl`,
  workspace: (t: string) => `substrate/runs/${t}/workspace.tar`,
  exit: (t: string) => `substrate/runs/${t}/exit.json`,
  done: (t: string) => `substrate/runs/${t}/done.json`,
  /** Written by the proxy (if absent) on the agent's first successful input download: the run reached the proxy. */
  started: (t: string) => `substrate/runs/${t}/started.json`,
};

export const PLACEHOLDER_CAPABILITY = "rrp_placeholder_injected_by_gateway";
