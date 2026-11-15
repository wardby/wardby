import { createHash } from "node:crypto";
import type { SubstrateActorShape } from "./run-store.js";

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
 * The actors of one run, by its shape: the paired shape (Claude Code) has the agent and the tool,
 * the single shape (Codex) the agent only.
 */
export function actorNamesFor(token: string, shape: SubstrateActorShape): string[] {
  return shape === "single" ? [agentActorName(token)] : [agentActorName(token), toolActorName(token)];
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
  role: "agent" | "tool" | "codex",
  image: string,
  cpuMillicores: number,
  memoryBytes: number,
  variant: string,
): string {
  return `wardby-${role}-${hex(`${role}|${image}|${cpuMillicores}|${memoryBytes}|${variant}`, 16)}`;
}

/**
 * The name of a per-round blob: round 1 (every run without warm rounds) keeps the original name,
 * round n > 1 gets `-<n>` before the extension.
 */
function perRound(t: string, base: string, extension: string, round = 1): string {
  return round === 1 ? `substrate/runs/${t}/${base}.${extension}` : `substrate/runs/${t}/${base}-${round}.${extension}`;
}

/** Blob keys for one run. The launch record lives in Postgres, not in the blob store. */
export const BLOB = {
  input: (t: string, round?: number) => perRound(t, "input", "json", round),
  toolSetup: (t: string) => `substrate/runs/${t}/tool-setup.json`,
  seed: (t: string) => `substrate/runs/${t}/seed.tar`,
  result: (t: string, round?: number) => perRound(t, "result", "json", round),
  transcript: (t: string, round?: number) => perRound(t, "transcript", "jsonl", round),
  workspace: (t: string, round?: number) => perRound(t, "workspace", "tar", round),
  exit: (t: string, round?: number) => perRound(t, "exit", "json", round),
  done: (t: string, round?: number) => perRound(t, "done", "json", round),
  /** Written by the proxy (if absent) on the agent's first successful input download: the run reached the proxy. */
  started: (t: string, round?: number) => perRound(t, "started", "json", round),
};

/** The BLOB keys that exist once per round (warm rounds, SUBSTRATE_WARM_ROUNDS). */
export const ROUND_BLOBS = ["input", "result", "transcript", "workspace", "exit", "done", "started"] as const;

/**
 * Warm rounds only: `{"round": n}`, the round the actors of this token are on, written by the
 * launcher when it adopts a parked run. Absent means round 1.
 */
export function roundBlob(t: string): string {
  return `substrate/runs/${t}/round.json`;
}

/** The highest round a token may reach (a bound on the rounds the proxy and launcher accept). */
export const MAX_ROUND = 1000;

/** Parses a round.json body; undefined when it is not `{"round": <1..MAX_ROUND>}`. */
export function parseRound(body: string): number | undefined {
  try {
    const round = (JSON.parse(body) as { round?: unknown } | null)?.round;
    return typeof round === "number" && Number.isInteger(round) && round >= 1 && round <= MAX_ROUND ? round : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The token a run's row moves to when another run adopts its parked actors (which keep the original
 * token): `wa-` + 20 hex chars of the run id, so it never matches a run token or a route.
 */
export function retiredRunToken(runId: string): string {
  return `wa-${hex(`retired|${runId}`, 20)}`;
}

export const PLACEHOLDER_CAPABILITY = "rrp_placeholder_injected_by_gateway";
