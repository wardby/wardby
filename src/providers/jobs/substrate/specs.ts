// Pure builders for the Substrate launcher: actor templates, egress policies and the per-run
// Secret. Templates are shared across runs and logged by Substrate's API server, so nothing
// here may carry a secret or a per-run value; the capability lives only in the per-run Secret,
// which the egress gateway reads to inject the header.

import { createHash } from "node:crypto";
import type { V1Secret } from "@kubernetes/client-node";
import { claudeToolLimits } from "../docker-isolation.js";
import type { JobSpec } from "../types.js";
import type { ActorTemplateSpec, EgressRule } from "./api.js";
import { TOOL_ACTOR_JWT_HEADER, templateName } from "./names.js";

export interface SubstrateLaunchConfig {
  atespace: string;
  /** Kubernetes namespace holding the per-run Secrets. */
  credentialsNamespace: string;
  proxyHost: string;
  proxyPort: number;
  workerSelector?: Record<string, string>;
}

const READY_PORT = 8080;
const ACTOR_METADATA_DIR = "/run/ate/actor";
const TOOL_JWT_AUDIENCE = "wardby-coding-proxy";
const TOOL_JWT_SECONDS = 600;

/** Env shared by both templates. Lives in the template, so it must never hold a per-run value. */
export function workerEnv(config: SubstrateLaunchConfig): { name: string; value: string }[] {
  return [{ name: "WARDBY_PROXY_URL", value: `http://${config.proxyHost}:${config.proxyPort}` }];
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

export function agentEgress(token: string, config: SubstrateLaunchConfig): EgressRule[] {
  return [
    {
      kind: "http",
      hostnames: [config.proxyHost],
      ports: [config.proxyPort],
      replaceHeaders: [
        {
          header: "X-Api-Key",
          credentialUri: `ate-secret://k8s.io/default/${config.credentialsNamespace}/${token}/capability`,
        },
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

/** The only place the capability appears. Never log or serialize this object. */
export function runSecret(token: string, capability: string, config: SubstrateLaunchConfig): V1Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: token,
      namespace: config.credentialsNamespace,
      labels: { "wardby.dev/substrate-run": token },
    },
    stringData: { capability },
  };
}
