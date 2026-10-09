/**
 * Docker objects for one sandbox-mode native run (docs/native-sandbox.md),
 * built the way the coding launcher builds its own (providers/jobs/
 * docker-isolation.ts): an internal per-run network whose only other member is
 * the native gateway container, and a single-use worker container that can
 * reach nothing else — no internet, no database, no Docker socket. Names carry
 * an opaque hash of the run id, never the id itself.
 */

import { isImmutableDockerImage, isolationToken } from "../providers/jobs/docker-isolation.js";
import { createHash } from "node:crypto";
import { WARM_INPUT_FILE } from "./warm-delivery.js";

export const NATIVE_WORKER_UID = 10001;
export const NATIVE_GATEWAY_ALIAS = "wardby-native-gateway";
export const NATIVE_GATEWAY_PORT = 8790;
/** The gateway's witness port: never reachable from a worker (see coding-proxy/deny-port.ts). */
export const NATIVE_GATEWAY_DENY_PORT = 8791;
export const NATIVE_WORKER_TMP_MB = 64;
const LABEL_MANAGED = "io.wardby.managed=true";
const LABEL_COMPONENT = "io.wardby.component=native-worker";

export interface NativeWorkerLimits {
  cpus: number;
  memoryMb: number;
  pids: number;
}

export const DEFAULT_NATIVE_WORKER_LIMITS: NativeWorkerLimits = { cpus: 1, memoryMb: 512, pids: 128 };

export interface NativeIsolationNames {
  network: string;
  worker: string;
}

export function nativeIsolationNames(runId: string): NativeIsolationNames {
  const token = isolationToken(runId);
  return { network: `wardby-nnet-${token}`, worker: `wardby-native-${token}` };
}

/** The label value tying a Docker object to its run, without exposing the run id. */
export function nativeRunLabel(runId: string): string {
  return createHash("sha256").update(runId).digest("hex");
}

function labels(runId: string): string[] {
  return [
    "--label",
    LABEL_MANAGED,
    "--label",
    LABEL_COMPONENT,
    "--label",
    `io.wardby.run-sha256=${nativeRunLabel(runId)}`,
  ];
}

/** A warm pool worker's name (native sandbox phase 6): its random token, never a run's hash. */
export function nativeWarmWorkerName(token: string): string {
  if (!/^[0-9a-f]{20}$/.test(token)) throw new Error("native_sandbox_invalid_warm_token");
  return `wardby-nwarm-${token}`;
}

export function nativeWarmIsolationNames(token: string): NativeIsolationNames {
  return { network: `wardby-nwnet-${token}`, worker: nativeWarmWorkerName(token) };
}

/** Docker's label filter for every warm pool object, and the label carrying its token. */
export const NATIVE_WARM_LABEL_FILTER = "io.wardby.pool=warm";
export const NATIVE_WARM_TOKEN_LABEL = "io.wardby.warm-worker";

function warmLabels(token: string): string[] {
  return [
    "--label",
    LABEL_MANAGED,
    "--label",
    LABEL_COMPONENT,
    "--label",
    NATIVE_WARM_LABEL_FILTER,
    "--label",
    `${NATIVE_WARM_TOKEN_LABEL}=${token}`,
  ];
}

/** Docker's label filter for every native worker object (the janitor lists by it). */
export const NATIVE_WORKER_LABEL_FILTER = LABEL_COMPONENT;

export function buildNativeNetworkCreateArgs(runId: string): string[] {
  return networkCreateArgs(nativeIsolationNames(runId).network, labels(runId));
}

export function buildNativeWarmNetworkCreateArgs(token: string): string[] {
  return networkCreateArgs(nativeWarmIsolationNames(token).network, warmLabels(token));
}

function networkCreateArgs(network: string, objectLabels: string[]): string[] {
  return [
    "network",
    "create",
    "--driver",
    "bridge",
    "--internal",
    "--ipv6=false",
    "--opt",
    "com.docker.network.bridge.gateway_mode_ipv4=isolated",
    "--opt",
    "com.docker.network.bridge.gateway_mode_ipv6=isolated",
    ...objectLabels,
    network,
  ];
}

/** Joins the gateway container to the run's network under the name workers dial. */
export function buildGatewayConnectArgs(runId: string, gatewayContainer: string): string[] {
  return gatewayConnectArgs(nativeIsolationNames(runId).network, gatewayContainer);
}

export function gatewayConnectArgs(network: string, gatewayContainer: string): string[] {
  return ["network", "connect", "--alias", NATIVE_GATEWAY_ALIAS, network, gatewayContainer];
}

export function buildGatewayDisconnectArgs(runId: string, gatewayContainer: string): string[] {
  return gatewayDisconnectArgs(nativeIsolationNames(runId).network, gatewayContainer);
}

export function gatewayDisconnectArgs(network: string, gatewayContainer: string): string[] {
  return ["network", "disconnect", "--force", network, gatewayContainer];
}

/**
 * `docker run -i` for the worker: its WorkerInput (capability included) arrives on stdin, so the
 * capability is never in its environment, argv, labels, or `docker inspect`. Not `--rm`: the
 * executor reads the exit code, then removes it.
 */
export function buildNativeWorkerRunArgs(input: {
  runId: string;
  image: string;
  limits: NativeWorkerLimits;
}): string[] {
  const names = nativeIsolationNames(input.runId);
  return workerRunArgs({ ...input, names, mode: ["-i"], env: [], objectLabels: labels(input.runId) });
}

/**
 * `docker run -d` for a warm pool worker: no input yet. It waits for one written into its /tmp by
 * `docker exec -i` after a run claims it (warm-delivery.ts), so the capability still never reaches
 * its environment, argv, or labels.
 */
export function buildNativeWarmWorkerRunArgs(input: {
  token: string;
  image: string;
  limits: NativeWorkerLimits;
  waitMs: number;
}): string[] {
  return workerRunArgs({
    ...input,
    names: nativeWarmIsolationNames(input.token),
    mode: ["-d"],
    env: [
      "--env",
      `NATIVE_WORKER_INPUT_FILE=${WARM_INPUT_FILE}`,
      "--env",
      `NATIVE_WORKER_INPUT_WAIT_MS=${Math.floor(input.waitMs)}`,
    ],
    objectLabels: warmLabels(input.token),
  });
}

function workerRunArgs(input: {
  image: string;
  limits: NativeWorkerLimits;
  names: NativeIsolationNames;
  mode: string[];
  env: string[];
  objectLabels: string[];
}): string[] {
  const { image, limits, names } = input;
  if (!isImmutableDockerImage(image)) {
    throw new Error(
      "native_sandbox_image_not_pinned: the worker image must be a digest (repo@sha256:...) or a local image id.",
    );
  }
  return [
    "run",
    ...input.mode,
    "--name",
    names.worker,
    "--pull",
    "never",
    "--user",
    `${NATIVE_WORKER_UID}:${NATIVE_WORKER_UID}`,
    "--network",
    names.network,
    "--read-only",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${NATIVE_WORKER_TMP_MB}m`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--security-opt",
    "seccomp=builtin",
    "--cgroupns",
    "private",
    "--ipc",
    "none",
    "--cpus",
    String(limits.cpus),
    "--memory",
    `${limits.memoryMb}m`,
    "--memory-swap",
    `${limits.memoryMb}m`,
    "--memory-swappiness",
    "0",
    "--pids-limit",
    String(limits.pids),
    "--restart",
    "no",
    "--log-driver",
    "local",
    "--log-opt",
    "max-size=1m",
    "--log-opt",
    "max-file=2",
    ...input.env,
    ...input.objectLabels,
    image,
  ];
}

/** The URL a worker dials: the gateway's alias on its own run network. */
export function nativeGatewayUrl(port = NATIVE_GATEWAY_PORT): string {
  return `http://${NATIVE_GATEWAY_ALIAS}:${port}/native-gateway/v1/call`;
}
