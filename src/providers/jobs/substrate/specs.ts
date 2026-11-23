// Pure builders for the Substrate launcher: actor templates, egress policies and the per-run
// Secret. The pieces shared with the native sandbox launcher (sizes, the actor metadata volume,
// the Secret shape, credential URIs) live in src/providers/substrate/. Templates are shared across
// runs and logged by Substrate's API server, so nothing here may carry a secret or a per-run value;
// the capability lives only in the per-run Secret, which the egress gateway reads to inject the
// header.
//
// A run with extra repositories gets one more durable volume, `repos`, mounted at /repos on the
// workspace holder only (the tool actor, or a Codex run's one actor; never Claude's agent). The
// volume carries no repository name: the holder's bridge makes /repos/<name> from its setup.
//
// Every template sets the bridge's command (BRIDGE_COMMANDS), standard and custom images alike,
// and the command is part of its name: an image's ENTRYPOINT is never used.
//
// A run with services gets, in its workspace holder's template only, one container per service: the
// catalog image, the fixed SERVICE_WAIT_SCRIPT and two volumes of its own (its script volume and its
// data volume); nothing of the entry but its name, digest and data path is in the template (the
// variant), and the holder's size includes the services'.

import { createHash } from "node:crypto";
import type { V1Secret } from "@kubernetes/client-node";
import { sidecarOnly, substrateServiceImage, type NonDockerService } from "../../../coding/services/catalog.js";
import { claudeToolLimits } from "../docker-isolation.js";
import { SERVICE_SHM_MIB } from "../docker-services.js";
import { SERVICE_SCRATCH_MIB } from "../kubernetes-isolation.js";
import type { JobSpec } from "../types.js";
import { REPOSITORY_MOUNT_ROOT } from "../storage-init.js";
import type { ActorTemplateSpec, ContainerSpec, EgressRule } from "../../substrate/api.js";
import { credentialUri, substrateSecret } from "../../substrate/secret.js";
import {
  READY_PORT,
  actorMetadataMount,
  actorMetadataVolume,
  sortedSelector,
  toSize,
  type Size,
} from "../../substrate/templates.js";
import { MCP_TOKEN_EGRESS_HEADER, TOOL_ACTOR_JWT_HEADER, templateName } from "./names.js";
import { SERVICES_ROOT, SERVICE_SCRIPT_DIR, servicesInOrder } from "./service-script.js";

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

/**
 * The command every template sets (ruling D5: standard and custom images alike), so an image's
 * ENTRYPOINT never matters, as on Kubernetes and Docker, and one custom image runs on all three.
 */
export const BRIDGE_COMMANDS = {
  agent: ["node", "/opt/wardby/substrate-bridge/agent.js"],
  tool: ["node", "/opt/wardby/substrate-bridge/tool.js"],
  codex: ["node", "/opt/wardby/substrate-bridge/codex.js"],
} as const satisfies Record<"agent" | "tool" | "codex", readonly string[]>;

/**
 * A service container's command (the template's only service-specific code, and no value): wait for
 * the run's start script in its own script volume, then run it. The golden snapshot holds this wait.
 */
export const SERVICE_WAIT_SCRIPT =
  "while [ ! -f /run/wardby-svc/start.sh ]; do sleep 0.2 2>/dev/null || sleep 1; done; exec /bin/sh /run/wardby-svc/start.sh";

/** One service as the template variant hashes it: the only catalog values a template carries. */
interface TemplateService {
  name: string;
  image: string;
  dataPath: string;
}

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

// Same split as the Kubernetes launcher, so a run has the same total size on both backends.
function agentSize(spec: JobSpec): Size {
  const tool = claudeToolLimits(spec);
  return toSize(spec.limits.cpus - tool.cpus, spec.limits.memoryMb - tool.memoryMb);
}

function toolSize(spec: JobSpec): Size {
  const tool = claudeToolLimits(spec);
  return toSize(tool.cpus, tool.memoryMb);
}

function add(a: Size, b: Size): Size {
  return { cpuMillicores: a.cpuMillicores + b.cpuMillicores, memoryBytes: a.memoryBytes + b.memoryBytes };
}

// A service's memory share on Substrate: its catalog memory, SERVICE_SCRATCH_MIB per writable path and
// SERVICE_SHM_MIB. Unlike Docker's serviceMemoryMib it leaves out the data disk: the data path is a
// durableDir volume, whose writes do not count against the actor's memory under gVisor, while
// rootfs writes (the writable paths, /tmp) do.
export function substrateServiceMemoryMib(service: NonDockerService): number {
  return service.resources.memoryMib + service.writablePaths.length * SERVICE_SCRATCH_MIB + SERVICE_SHM_MIB;
}

/** What the run's services add to the workspace holder's size (zero without services). */
function servicesShare(spec: JobSpec): Size {
  const services = servicesInOrder(spec.services ?? []);
  return {
    cpuMillicores: services.reduce((sum, s) => sum + s.resources.cpuMillicores, 0),
    memoryBytes: services.reduce((sum, s) => sum + substrateServiceMemoryMib(s) * 2 ** 20, 0),
  };
}

// Digest of every template field that is not image or size, with worker selector keys sorted so
// the same selector always hashes the same way. The role's bridge command is hashed in, so a change
// to it renames the template. `repos` (the /repos volume) is hashed in only when set, so a template
// without it keeps one name whether or not repositories exist anywhere. `services` likewise: only a
// template with services hashes them (with the wait script), so a spec without services keeps its name.
function templateVariant(
  config: SubstrateLaunchConfig,
  role: keyof typeof BRIDGE_COMMANDS,
  options: { repos?: boolean; services?: TemplateService[] } = {},
): string {
  const selector = sortedSelector(config.workerSelector);
  return createHash("sha256")
    .update(
      JSON.stringify({
        env: workerEnv(config),
        workerSelector: selector,
        command: BRIDGE_COMMANDS[role],
        ...(options.repos ? { repos: true } : {}),
        ...(options.services?.length ? { services: { wait: SERVICE_WAIT_SCRIPT, entries: options.services } } : {}),
      }),
    )
    .digest("hex");
}

const actorVolume = actorMetadataVolume;
const actorMount = actorMetadataMount;

/**
 * The workspace holder's volumes and mounts: the run directory, /workspace, and, only for a run
 * with extra repositories, /repos (no name in it); then, for service i (in name order), its script
 * volume at /run/wardby-services/<i> and its data volume (holder: no mount); then the actor metadata.
 */
function holderStorage(spec: JobSpec): {
  volumes: ActorTemplateSpec["volumes"];
  volumeMounts: { name: string; mountPath: string }[];
  repos: boolean;
  services: TemplateService[];
} {
  const repos = spec.repositories !== undefined;
  const services = servicesInOrder(spec.services ?? []);
  return {
    volumeMounts: [
      { name: "run", mountPath: "/run/wardby" },
      { name: "workspace", mountPath: "/workspace" },
      ...(repos ? [{ name: "repos", mountPath: REPOSITORY_MOUNT_ROOT }] : []),
      ...services.map((_, i) => ({ name: `svc-${i}`, mountPath: `${SERVICES_ROOT}/${i}` })),
      actorMount,
    ],
    volumes: [
      { name: "run", durableDir: true as const },
      { name: "workspace", durableDir: true as const },
      ...(repos ? [{ name: "repos", durableDir: true as const }] : []),
      ...services.flatMap((_, i) => [
        { name: `svc-${i}`, durableDir: true as const },
        { name: `svc-${i}-data`, durableDir: true as const },
      ]),
      actorVolume,
    ],
    repos,
    services: services
      .map(sidecarOnly)
      .map((s) => ({ name: s.name, image: substrateServiceImage(s), dataPath: s.dataPath })),
  };
}

/**
 * One container per service, in name order: its image, the fixed wait script, and only its own two
 * volumes (script and data). No env and no wakeup probe: values reach it only through start.sh.
 */
function serviceContainers(spec: JobSpec): ContainerSpec[] {
  return servicesInOrder(spec.services ?? [])
    .map(sidecarOnly)
    .map((service, i) => ({
      name: `svc-${service.name}`,
      image: substrateServiceImage(service),
      command: ["/bin/sh", "-c", SERVICE_WAIT_SCRIPT],
      volumeMounts: [
        { name: `svc-${i}`, mountPath: SERVICE_SCRIPT_DIR },
        { name: `svc-${i}-data`, mountPath: service.dataPath },
      ],
    }));
}

export function agentTemplate(spec: JobSpec, config: SubstrateLaunchConfig): ActorTemplateSpec {
  const size = agentSize(spec);
  return {
    atespace: config.atespace,
    name: templateName("agent", spec.image, size.cpuMillicores, size.memoryBytes, templateVariant(config, "agent")),
    ...(config.workerSelector ? { workerSelector: config.workerSelector } : {}),
    containers: [
      {
        name: "agent",
        image: spec.image,
        command: [...BRIDGE_COMMANDS.agent],
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
  const size = add(toSize(spec.limits.cpus, spec.limits.memoryMb), servicesShare(spec));
  const cold = { ...config, warmRounds: false };
  const storage = holderStorage(spec);
  return {
    atespace: config.atespace,
    name: templateName(
      "codex",
      spec.image,
      size.cpuMillicores,
      size.memoryBytes,
      templateVariant(cold, "codex", { repos: storage.repos, services: storage.services }),
    ),
    ...(config.workerSelector ? { workerSelector: config.workerSelector } : {}),
    containers: [
      {
        name: "agent",
        image: spec.image,
        command: [...BRIDGE_COMMANDS.codex],
        env: workerEnv(cold),
        wakeupProbe: { path: "/readyz", port: READY_PORT },
        volumeMounts: storage.volumeMounts,
      },
      ...serviceContainers(spec),
    ],
    volumes: storage.volumes,
    ...size,
    snapshotFidelity: "MEMORY",
  };
}

export function toolTemplate(spec: JobSpec, config: SubstrateLaunchConfig): ActorTemplateSpec {
  if (!spec.toolImage) throw new Error("substrate_tool_image_missing");
  const size = add(toolSize(spec), servicesShare(spec));
  const storage = holderStorage(spec);
  return {
    atespace: config.atespace,
    name: templateName(
      "tool",
      spec.toolImage,
      size.cpuMillicores,
      size.memoryBytes,
      templateVariant(config, "tool", { repos: storage.repos, services: storage.services }),
    ),
    ...(config.workerSelector ? { workerSelector: config.workerSelector } : {}),
    containers: [
      {
        name: "tool",
        image: spec.toolImage,
        command: [...BRIDGE_COMMANDS.tool],
        env: workerEnv(config),
        wakeupProbe: { path: "/readyz", port: READY_PORT },
        volumeMounts: storage.volumeMounts,
      },
      ...serviceContainers(spec),
    ],
    volumes: storage.volumes,
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
  const secretUri = (key: string) => credentialUri(config.credentialsNamespace, token, key);
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
  return substrateSecret({
    name: token,
    namespace: config.credentialsNamespace,
    label: { key: "wardby.dev/substrate-run", value: token },
    data: mcpToken === undefined ? { capability } : { capability, [RUN_SECRET_MCP_TOKEN_KEY]: mcpToken },
  });
}
