import { createHash } from "node:crypto";
import { isCodingRepositoryName } from "../../../coding/protocol.js";
import type { ServiceFailureReason, ServiceState } from "../service-state.js";
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

/** The header a bridge names its protocol in (substrate-bridge/constants.ts BRIDGE_PROTOCOL_HEADER). */
export const BRIDGE_PROTOCOL_HEADER = "x-wardby-bridge-protocol";
/** The bridge protocols this release's proxy serves, both ends included (ruling D4: a range, 1 to start). */
export const BRIDGE_PROTOCOL_RANGE = { min: 1, max: 1 } as const;

/** The header the agent actor sends its MCP token placeholder in; the egress gateway fills it (specs.ts agentEgress). */
export const MCP_TOKEN_EGRESS_HEADER = "X-Wardby-Mcp-Token";

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

const TEMPLATE_NAME = /^wardby-(agent|tool|codex)-[0-9a-f]{16}$/;

/** The role a templateName() names; undefined for any other string (not a template wardby names). */
export function templateRoleOf(name: string): "agent" | "tool" | "codex" | undefined {
  const match = TEMPLATE_NAME.exec(name);
  return match ? (match[1] as "agent" | "tool" | "codex") : undefined;
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
  /**
   * Written by the proxy (if absent) when an authenticated bridge request named a protocol outside
   * BRIDGE_PROTOCOL_RANGE: `{"protocol": <int or null>}`. The launcher fails the run with
   * substrate_bridge_incompatible. Once per run (not per round).
   */
  bridgeRefused: (t: string) => `substrate/runs/${t}/bridge-refused.json`,
  /**
   * Written by the proxy (if absent) from the holder's image check: `{"item": <SubstrateImageItem>}`.
   * The launcher fails the run with substrate_image_incomplete:<item>. Once per run.
   */
  imageIncomplete: (t: string) => `substrate/runs/${t}/image-incomplete.json`,
  /**
   * Written (replaced) by the proxy from the holder bridge's `POST services`: the validated
   * `{"services": [...]}` (parseServicesReport), never the request body. Round 1 only (a run with
   * services never parks). The launcher waits on it in launch().
   */
  services: (t: string) => `substrate/runs/${t}/services.json`,
};

/** The fixed items a bridge's image check may report (substrate-bridge/constants.ts IMAGE_ITEMS). */
export const SUBSTRATE_IMAGE_ITEMS = ["user", "runner", "tar", "workspace", "run_dir"] as const;
export type SubstrateImageItem = (typeof SUBSTRATE_IMAGE_ITEMS)[number];

/** Whether `value` is one of SUBSTRATE_IMAGE_ITEMS (never any other string: the report carries no free text). */
export function isSubstrateImageItem(value: unknown): value is SubstrateImageItem {
  return typeof value === "string" && (SUBSTRATE_IMAGE_ITEMS as readonly string[]).includes(value);
}

/** The largest services report the proxy accepts. */
export const MAX_SERVICES_REPORT_BYTES = 4096;
/** The most readiness probes a report may count (the start script writes at most 5 digits). */
const MAX_REPORTED_ATTEMPTS = 10_000;
// Record-typed so a value added to service-state.ts fails to compile here until it is listed.
const SERVICE_STATE_SET: Record<ServiceState, true> = { pending: true, probing: true, ready: true, failed: true };
const SERVICE_FAILURE_REASON_SET: Record<ServiceFailureReason, true> = {
  image_unavailable: true,
  start_failed: true,
  exited: true,
  probe_failed: true,
  timed_out: true,
};
const SERVICE_STATES = Object.keys(SERVICE_STATE_SET) as ServiceState[];
const SERVICE_FAILURE_REASONS = Object.keys(SERVICE_FAILURE_REASON_SET) as ServiceFailureReason[];

/** One service's state as the holder's bridge reports it (service-state.ts values only). */
export interface SubstrateServiceReport {
  name: string;
  state: ServiceState;
  attempts?: number;
  reason?: ServiceFailureReason;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `{ services: [...] }` exactly: 1..allowed.length entries, each `{ name, state, attempts?, reason? }`
 * with name in `allowed` (no name twice), state a ServiceState, attempts an integer 0..10000, reason a
 * ServiceFailureReason and only with state "failed"; no other key anywhere. Rebuilt field by field, so
 * nothing of the input but these enum values, validated names and the integer is kept. Undefined for
 * anything else.
 */
export function parseServicesReport(value: unknown, allowed: readonly string[]): SubstrateServiceReport[] | undefined {
  if (!isPlainObject(value)) return undefined;
  const top = Object.keys(value);
  if (top.length !== 1 || top[0] !== "services") return undefined;
  const entries = value.services;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > allowed.length) return undefined;
  const seen = new Set<string>();
  const out: SubstrateServiceReport[] = [];
  for (const entry of entries as unknown[]) {
    if (!isPlainObject(entry)) return undefined;
    if (Object.keys(entry).some((key) => key !== "name" && key !== "state" && key !== "attempts" && key !== "reason"))
      return undefined;
    const { name, state, attempts, reason } = entry;
    if (typeof name !== "string" || !allowed.includes(name) || seen.has(name)) return undefined;
    if (typeof state !== "string" || !(SERVICE_STATES as readonly string[]).includes(state)) return undefined;
    if (
      attempts !== undefined &&
      (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 0 || attempts > MAX_REPORTED_ATTEMPTS)
    )
      return undefined;
    if (reason !== undefined) {
      if (state !== "failed") return undefined;
      if (typeof reason !== "string" || !(SERVICE_FAILURE_REASONS as readonly string[]).includes(reason))
        return undefined;
    }
    seen.add(name);
    out.push({
      name,
      state: state as ServiceState,
      ...(attempts !== undefined ? { attempts } : {}),
      ...(reason !== undefined ? { reason: reason as ServiceFailureReason } : {}),
    });
  }
  return out;
}

/** An extra repository's name, refused unless it is a link name (never `workspace`, never a path). */
function repositoryName(name: string): string {
  if (!isCodingRepositoryName(name)) throw new Error("substrate_repository_name_invalid");
  return name;
}

/**
 * Per-repository blob keys of a run's extra repositories (multi-repository runs). Throws
 * "substrate_repository_name_invalid" for a name that is not a link name (isCodingRepositoryName).
 * Not in BLOB: every BLOB entry is called with the token alone.
 */
export const REPO_BLOB = {
  /** substrate/runs/<t>/repos/<name>/seed.tar */
  seed: (t: string, name: string): string => `substrate/runs/${t}/repos/${repositoryName(name)}/seed.tar`,
  /** substrate/runs/<t>/repos/<name>/workspace.tar, or workspace-<n>.tar for round n > 1 (perRound). */
  workspace: (t: string, name: string, round?: number): string =>
    perRound(t, `repos/${repositoryName(name)}/workspace`, "tar", round),
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
