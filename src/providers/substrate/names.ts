import { createHash } from "node:crypto";

/** The first `length` hex chars of sha256(input). */
export const hex = (input: string, length: number): string =>
  createHash("sha256").update(input).digest("hex").slice(0, length);

/** Stable, label-safe token for a wardby run: "wr-" + 20 hex chars of sha256(runId). */
export function substrateRunToken(runId: string): string {
  return `wr-${hex(runId, 20)}`;
}

/** A native sandbox run's actor: the run token and this suffix (substrate-bridge/constants.ts NATIVE_SUFFIX). */
export const NATIVE_ACTOR_SUFFIX = "-native";
/** The native template's canary actor (substrate-bridge/constants.ts CANARY_SUFFIX). */
export const CANARY_ACTOR_SUFFIX = "-canary";

/** The actor name of a native sandbox run: `<token>-native`. */
export function nativeActorName(token: string): string {
  return `${token}${NATIVE_ACTOR_SUFFIX}`;
}

/**
 * A startup canary's actor name: a run-shaped token of `canary|<nonce>` plus `-canary`. The nonce is
 * random, so the name is unguessable: the gateway's unauthenticated canary route accepts only it.
 */
export function nativeCanaryActorName(nonce: string): string {
  return `${substrateRunToken(`canary|${nonce}`)}${CANARY_ACTOR_SUFFIX}`;
}

/**
 * Template name derived from its content: `wardby-<role>-` + 16 hex chars. `variant` is a stable
 * digest of everything else in the template (env, worker selector), so two templates that differ
 * in any field never share a name.
 */
export function templateName(
  role: "agent" | "tool" | "codex" | "native",
  image: string,
  cpuMillicores: number,
  memoryBytes: number,
  variant: string,
): string {
  return `wardby-${role}-${hex(`${role}|${image}|${cpuMillicores}|${memoryBytes}|${variant}`, 16)}`;
}
