// Pure builders for the Substrate launcher: actor templates, egress policies and the per-run
// Secret. Templates are shared across runs and logged by Substrate's API server, so nothing
// here may carry a secret or a per-run value; the capability lives only in the per-run Secret,
// which the egress gateway reads to inject the header.

import { createHash } from "node:crypto";
import type { V1Secret } from "@kubernetes/client-node";
import { claudeToolLimits } from "../docker-isolation.js";
import type { JobSpec } from "../types.js";
import type { ActorTemplateSpec, EgressRule } from "./api.js";
import { MCP_TOKEN_EGRESS_HEADER, TOOL_ACTOR_JWT_HEADER, templateName } from "./names.js";

export interface SubstrateLaunchConfig {
  atespace: string;
  /** Kubernetes namespace holding the per-run Secrets. */
  credentialsNamespace: string;
  proxyHost: string;
  proxyPort: number;
  workerSelector?: Record<string, string>;
  /**
   * Warm rounds (SUBSTRATE_WARM_ROUNDS, experimental): the templates tell both bridges to stay for a
   * follow-up round instead of idling after their uploads. Absent or false: templates are unchanged.
   */
  warmRounds?: boolean;
}

/** The template env that switches the bridges into warm rounds (substrate-bridge/constants.ts WARM_ROUNDS_ENV). */
export const WARM_ROUNDS_ENV = "WARDBY_SUBSTRATE_WARM_ROUNDS";

const READY_PORT = 8080;
const ACTOR_METADATA_DIR = "/run/ate/actor";
const TOOL_JWT_AUDIENCE = "wardby-coding-proxy";
const TOOL_JWT_SECONDS = 600;

/** Env shared by both templates. Lives in the template, so it must never hold a per-run value. */
export function workerEnv(config: SubstrateLaunchConfig): { name: string; value: string }[] {
  return [
    { name: "WARDBY_PROXY_URL", value: `http://${config.proxyHost}:${config.proxyPort}` },
    // Not a per-run value: the same for every run of a deployment with warm rounds on.
    ...(config.warmRounds ? [{ name: WARM_ROUNDS_ENV, value: "1" }] : []),
  ];
}

interface Size {
  cpuMillicores: number;
  memoryBytes: number;
}

// Refuse rather than resize: the Kubernetes launcher's split is the policy, so a run whose share
// rounds to nothing is a configuration error, not something to paper over.
function toSize(cpus: number, memoryMb: number): Size {
  const size = { cpuMillicores: Math.round(cpus * 1000), memoryBytes: Math.round(memoryMb * 2 ** 20) };
  if (size.cpuMillicores <= 0 || size.memoryBytes <= 0) throw new Error("substrate_limits_too_small");
  return size;
}

// Same split as the Kubernetes launcher, so a run has the same total size on both backends.
function agentSize(spec: JobSpec): Size {
  const tool = claudeToolLimits(spec);
  return toSize(spec.limits.cpus - tool.cpus, spec.limits.memoryMb - tool.memoryMb);
}

function toolSize(spec: JobSpec): Size {
  const tool = claudeToolLimits(spec);
  return toSize(tool.cpus, tool.memoryMb);
}

// Digest of every template field that is not image or size, with worker selector keys sorted so
// the same selector always hashes the same way.
function templateVariant(config: SubstrateLaunchConfig): string {
  const selector = Object.fromEntries(
    Object.entries(config.workerSelector ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return createHash("sha256")
    .update(JSON.stringify({ env: workerEnv(config), workerSelector: selector }))
    .digest("hex");
}

// The files name/atespace/uid appear at the volume root, so the mount path is the directory.
const actorVolume = { name: "actor", actorMetadata: { path: "" } } as const;
const actorMount = { name: "actor", mountPath: ACTOR_METADATA_DIR };

export function agentTemplate(spec: JobSpec, config: SubstrateLaunchConfig): ActorTemplateSpec {
  const size = agentSize(spec);
  return {
    atespace: config.atespace,
    name: templateName("agent", spec.image, size.cpuMillicores, size.memoryBytes, templateVariant(config)),
    ...(config.workerSelector ? { workerSelector: config.workerSelector } : {}),
    containers: [
      {
        name: "agent",
        image: spec.image,
        env: workerEnv(config),
        wakeupProbe: { path: "/readyz", port: READY_PORT },
        volumeMounts: [{ name: "run", mountPath: "/run/wardby" }, actorMount],
      },
    ],
    volumes: [{ name: "run", durableDir: true }, actorVolume],
    ...size,
    snapshotFidelity: "MEMORY",
  };
}

/**
 * The Codex run's one actor (the single shape): the Codex bridge and worker in one container, with
 * the run's whole size (as Kubernetes gives Codex), and the workspace on its own durable volume.
 * Never the warm-rounds env: Codex rounds always start cold, so the bridge never stays for one.
 */
export function codexTemplate(spec: JobSpec, config: SubstrateLaunchConfig): ActorTemplateSpec {
  const size = toSize(spec.limits.cpus, spec.limits.memoryMb);
  const cold = { ...config, warmRounds: false };
  return {
    atespace: config.atespace,
    name: templateName("codex", spec.image, size.cpuMillicores, size.memoryBytes, templateVariant(cold)),
    ...(config.workerSelector ? { workerSelector: config.workerSelector } : {}),
    containers: [
      {
        name: "agent",
        image: spec.image,
        env: workerEnv(cold),
        wakeupProbe: { path: "/readyz", port: READY_PORT },
        volumeMounts: [
          { name: "run", mountPath: "/run/wardby" },
          { name: "workspace", mountPath: "/workspace" },
          actorMount,
        ],
      },
    ],
    volumes: [{ name: "run", durableDir: true }, { name: "workspace", durableDir: true }, actorVolume],
    ...size,
    snapshotFidelity: "MEMORY",
  };
}

export function toolTemplate(spec: JobSpec, config: SubstrateLaunchConfig): ActorTemplateSpec {
  if (!spec.toolImage) throw new Error("substrate_tool_image_missing");
  const size = toolSize(spec);
  return {
    atespace: config.atespace,
    name: templateName("tool", spec.toolImage, size.cpuMillicores, size.memoryBytes, templateVariant(config)),
    ...(config.workerSelector ? { workerSelector: config.workerSelector } : {}),
    containers: [
      {
        name: "tool",
        image: spec.toolImage,
        env: workerEnv(config),
        wakeupProbe: { path: "/readyz", port: READY_PORT },
        volumeMounts: [
          { name: "run", mountPath: "/run/wardby" },
          { name: "workspace", mountPath: "/workspace" },
          actorMount,
        ],
      },
    ],
    volumes: [{ name: "run", durableDir: true }, { name: "workspace", durableDir: true }, actorVolume],
    ...size,
    snapshotFidelity: "MEMORY",
  };
}

/** The per-run Secret's key for the run's MCP token (runSecret; agentEgress with `mcp`). */
export const RUN_SECRET_MCP_TOKEN_KEY = "mcpToken";

/**
 * The agent's one rule: the proxy, its X-Api-Key filled from the per-run Secret (named after the
 * token). With `mcp`, the same rule also fills X-Wardby-Mcp-Token from the Secret's mcpToken key;
 * the gateway replaces a header only when the request carries it, so non-MCP requests are unchanged.
 */
export function agentEgress(token: string, config: SubstrateLaunchConfig, options?: { mcp?: boolean }): EgressRule[] {
  const secretUri = (key: string) => `ate-secret://k8s.io/default/${config.credentialsNamespace}/${token}/${key}`;
  return [
    {
      kind: "http",
      hostnames: [config.proxyHost],
      ports: [config.proxyPort],
      replaceHeaders: [
        { header: "X-Api-Key", credentialUri: secretUri("capability") },
        ...(options?.mcp
          ? [{ header: MCP_TOKEN_EGRESS_HEADER, credentialUri: secretUri(RUN_SECRET_MCP_TOKEN_KEY) }]
          : []),
      ],
    },
  ];
}

export function toolEgress(config: SubstrateLaunchConfig): EgressRule[] {
  return [
    {
      kind: "http",
      hostnames: [config.proxyHost],
      ports: [config.proxyPort],
      replaceHeaders: [
        {
          header: TOOL_ACTOR_JWT_HEADER,
          prefix: "Bearer ",
          actorJwt: { audiences: [TOOL_JWT_AUDIENCE], expirationSeconds: TOOL_JWT_SECONDS },
        },
      ],
    },
  ];
}

/** The only place the capability and the MCP token appear. Never log or serialize this object. */
export function runSecret(
  token: string,
  capability: string,
  config: SubstrateLaunchConfig,
  mcpToken?: string,
): V1Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: token,
      namespace: config.credentialsNamespace,
      labels: { "wardby.dev/substrate-run": token },
    },
    stringData: mcpToken === undefined ? { capability } : { capability, [RUN_SECRET_MCP_TOKEN_KEY]: mcpToken },
  };
}
