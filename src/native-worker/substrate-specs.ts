/**
 * Pure builders for the native sandbox on Substrate (NATIVE_SANDBOX_LAUNCHER=substrate): the one
 * actor template per configuration, a run actor's egress policy, and its per-run Secret.
 *
 * Substrate logs templates and policies, and every run actor resumes from the template's golden
 * snapshot, so neither carries anything of a run: the template holds only the worker's image,
 * command, size and two env values (substrate mode, and the gateway's URL), and the policy only a
 * `credentialUri` reference. The run's capability lives only in the per-run Secret, which the
 * egress gateway reads to put it in the worker's Authorization header on the wire.
 */

import type { V1Secret } from "@kubernetes/client-node";
import type { ActorTemplateSpec, EgressRule } from "../providers/substrate/api.js";
import { templateName } from "../providers/substrate/names.js";
import { credentialUri, substrateSecret } from "../providers/substrate/secret.js";
import {
  actorMetadataMount,
  actorMetadataVolume,
  READY_PORT,
  sortedSelector,
  toSize,
} from "../providers/substrate/templates.js";
import { NATIVE_SUBSTRATE_ENV } from "./substrate-mode.js";

export interface NativeSubstrateLaunchConfig {
  atespace: string;
  credentialsNamespace: string;
  /** NATIVE_SANDBOX_WORKER_IMAGE, repo@sha256:… */
  image: string;
  /** NATIVE_GATEWAY_URL (http, by hostname). */
  gatewayUrl: string;
  cpus: number;
  memoryMb: number;
  workerSelector?: Record<string, string>;
}

/** The worker's own entrypoint, set on the template like the bridges' commands (an image ENTRYPOINT is never used). */
export const NATIVE_WORKER_COMMAND = ["node", "/opt/wardby/native-worker/main.js"] as const;

/** The per-run Secret's one key: the run's gateway capability. */
export const NATIVE_RUN_SECRET_KEY = "capability";

/** The label every per-run native Secret carries (value: the run token), for a sweep to find them. */
export const NATIVE_RUN_SECRET_LABEL = "wardby.dev/substrate-native-run";

/** The gateway's hostname and port from NATIVE_GATEWAY_URL (port 80 when the URL has none). */
export function gatewayTarget(gatewayUrl: string): { host: string; port: number } {
  const url = new URL(gatewayUrl);
  return { host: url.hostname, port: url.port ? Number(url.port) : 80 };
}

/** The worker's whole environment: substrate mode, and where the gateway is. Never a secret or a run value. */
function nativeEnv(config: NativeSubstrateLaunchConfig): { name: string; value: string }[] {
  return [
    { name: NATIVE_SUBSTRATE_ENV, value: "1" },
    { name: "NATIVE_GATEWAY_URL", value: config.gatewayUrl },
  ];
}

/**
 * One template per configuration; no per-run value. Name: templateName("native", image, size,
 * variant of { env, command, workerSelector sorted }), so any change of image, size, gateway or
 * selector names a new template. Throws substrate_limits_too_small for a size that rounds to nothing.
 */
export function nativeTemplate(config: NativeSubstrateLaunchConfig): ActorTemplateSpec {
  const size = toSize(config.cpus, config.memoryMb);
  const env = nativeEnv(config);
  const variant = JSON.stringify({
    env,
    command: NATIVE_WORKER_COMMAND,
    workerSelector: sortedSelector(config.workerSelector),
  });
  return {
    atespace: config.atespace,
    name: templateName("native", config.image, size.cpuMillicores, size.memoryBytes, variant),
    ...(config.workerSelector ? { workerSelector: config.workerSelector } : {}),
    containers: [
      {
        name: "native",
        image: config.image,
        command: [...NATIVE_WORKER_COMMAND],
        env,
        wakeupProbe: { path: "/readyz", port: READY_PORT },
        volumeMounts: [{ name: "tmp", mountPath: "/tmp" }, actorMetadataMount],
      },
    ],
    volumes: [{ name: "tmp", durableDir: true }, actorMetadataVolume],
    ...size,
    snapshotFidelity: "MEMORY",
  };
}

/** The run actor's one rule: the gateway host and port, Authorization ← "Bearer " + the Secret's capability. */
export function nativeEgress(token: string, config: NativeSubstrateLaunchConfig): EgressRule[] {
  const { host, port } = gatewayTarget(config.gatewayUrl);
  return [
    {
      kind: "http",
      hostnames: [host],
      ports: [port],
      replaceHeaders: [
        {
          header: "Authorization",
          prefix: "Bearer ",
          credentialUri: credentialUri(config.credentialsNamespace, token, NATIVE_RUN_SECRET_KEY),
        },
      ],
    },
  ];
}

/** The per-run Secret (name = token, key capability, label wardby.dev/substrate-native-run). Never log it. */
export function nativeRunSecret(token: string, capability: string, config: NativeSubstrateLaunchConfig): V1Secret {
  return substrateSecret({
    name: token,
    namespace: config.credentialsNamespace,
    label: { key: NATIVE_RUN_SECRET_LABEL, value: token },
    data: { [NATIVE_RUN_SECRET_KEY]: capability },
  });
}
