// Adapts the build-time-generated Substrate gRPC client (src/generated/substrate, produced by
// `npm run build:substrate`) to the SubstrateApi interface. Server error messages may echo
// request content, so every failure that crosses this boundary carries a fixed message.
import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import {
  ActorSchema,
  ActorState as WireActorState,
  ActorMetadataField,
  ActorMetadataDataSourceSchema,
  ActorMetadataItemSchema,
  ActorTemplateSchema,
  ContainerSchema,
  Control,
  CreateActorEgressPolicyRequestSchema,
  CreateActorRequestSchema,
  CreateActorTemplateRequestSchema,
  CredentialHeaderSchema,
  DeleteActorEgressPolicyRequestSchema,
  DeleteActorRequestSchema,
  DeleteActorTemplateRequestSchema,
  DurableDirVolumeSourceSchema,
  EgressPolicySchema,
  EgressRuleSchema,
  EnvVarSchema,
  GetActorRequestSchema,
  GetActorTemplateRequestSchema,
  HttpGetActionSchema,
  HttpRuleEffectsSchema,
  HttpRuleSchema,
  HttpsRuleSchema,
  ListWorkersRequestSchema,
  ObjectRefSchema,
  PortsSchema,
  ResourceMetadataSchema,
  ResourceRequirementsSchema,
  ResourcesSchema,
  ResumeActorRequestSchema,
  DurabilityMode,
  SuspendActorRequestSchema,
  SuspendOptionsSchema,
  SelectorSchema,
  SnapshotConfigSchema,
  SnapshotFidelity,
  SystemInfoDataSourceSchema,
  SystemInfoVolumeSourceSchema,
  TrustBundleDataSourceSchema,
  VolumeMountSchema,
  VolumeSchema,
  WakeupProbeSchema,
  ActorJwtSourceSchema,
  type EgressRule as WireEgressRule,
  type Volume as WireVolume,
} from "../../../generated/substrate/substrate/ateapi/v1/ateapi_pb.js";
import {
  SubstrateAlreadyExistsError,
  SubstrateExhaustedError,
  SubstrateNotFoundError,
  SubstrateTemplateMissingError,
  SubstrateUnavailableError,
  type ActorInfo,
  type ActorState,
  type ActorTemplateSpec,
  type EgressRule,
  type SubstrateApi,
  type TemplateInfo,
  type WorkerInfo,
} from "./api.js";

export interface SubstrateClientConfig {
  /** e.g. https://api.ate-system.svc.cluster.local:443 */
  baseUrl: string;
  /** Service-account token file; re-read on every call because projected tokens rotate. */
  tokenFile: string;
  /** CA bundle used to verify the API server's TLS certificate. */
  caFile?: string;
  /** TLS server name, for reaching the API server through a port-forward. */
  serverName?: string;
}

/** The only egress policy name Substrate accepts per actor. */
const EGRESS_POLICY_NAME = "default";

export function createSubstrateApi(config: SubstrateClientConfig): SubstrateApi {
  const transport = createGrpcTransport({
    baseUrl: config.baseUrl,
    nodeOptions: {
      ...(config.caFile ? { ca: readFileSync(config.caFile) } : {}),
      ...(config.serverName ? { servername: config.serverName } : {}),
    },
    interceptors: [
      (next) => async (req) => {
        // Bearer-JWT authentication (no client certificate): the principal is the token's sub.
        req.header.set("authorization", `Bearer ${readFileSync(config.tokenFile, "utf8").trim()}`);
        return next(req);
      },
    ],
  });
  return createSubstrateApiFromTransport(transport);
}

export function createSubstrateApiFromTransport(transport: Transport): SubstrateApi {
  return new GrpcSubstrateApi(createClient(Control, transport));
}

function codeOf(error: unknown): Code | undefined {
  return error instanceof ConnectError ? error.code : undefined;
}

function unavailable(): SubstrateUnavailableError {
  return new SubstrateUnavailableError("substrate_unavailable");
}

/** Substrate's answer (FailedPrecondition) when an actor's template is gone; a fixed message. */
function templateMissing(): never {
  throw new SubstrateTemplateMissingError("substrate_template_missing");
}

const STATE_NAMES: Partial<Record<WireActorState, ActorState>> = {
  [WireActorState.RESUMING]: "RESUMING",
  [WireActorState.RUNNING]: "RUNNING",
  [WireActorState.SUSPENDING]: "SUSPENDING",
  [WireActorState.SUSPENDED]: "SUSPENDED",
  [WireActorState.CRASHED]: "CRASHED",
  [WireActorState.DELETING]: "DELETING",
  [WireActorState.REVERTING]: "REVERTING",
};

function volumeToWire(volume: ActorTemplateSpec["volumes"][number]): WireVolume {
  if ("durableDir" in volume) {
    return create(VolumeSchema, {
      name: volume.name,
      durableDir: create(DurableDirVolumeSourceSchema, {}),
    });
  }
  if ("trustBundle" in volume) {
    return create(VolumeSchema, {
      name: volume.name,
      systemInfo: create(SystemInfoVolumeSourceSchema, {
        dataSources: [
          create(SystemInfoDataSourceSchema, {
            trustBundle: create(TrustBundleDataSourceSchema, {
              names: volume.trustBundle.names,
              path: volume.trustBundle.path,
            }),
          }),
        ],
      }),
    });
  }
  // Relative to the volume and inside it (no `..` segment); a fixed message, never the path.
  const path = volume.actorMetadata.path;
  if (path.startsWith("/") || path.split("/").includes("..")) throw new Error("substrate_template_invalid");
  const dir = path.replace(/\/+$/, "");
  const item = (field: ActorMetadataField, file: string) =>
    create(ActorMetadataItemSchema, { field, path: dir ? `${dir}/${file}` : file });
  return create(VolumeSchema, {
    name: volume.name,
    systemInfo: create(SystemInfoVolumeSourceSchema, {
      dataSources: [
        create(SystemInfoDataSourceSchema, {
          actorMetadata: create(ActorMetadataDataSourceSchema, {
            items: [
              item(ActorMetadataField.NAME, "name"),
              item(ActorMetadataField.ATESPACE, "atespace"),
              item(ActorMetadataField.UID, "uid"),
            ],
          }),
        }),
      ],
    }),
  });
}

function ruleToWire(rule: EgressRule): WireEgressRule {
  const ports = rule.ports ? create(PortsSchema, { numbers: rule.ports }) : undefined;
  const effects = rule.replaceHeaders?.length
    ? create(HttpRuleEffectsSchema, {
        replaceHeaders: rule.replaceHeaders.map((h) =>
          create(CredentialHeaderSchema, {
            header: h.header,
            prefix: h.prefix ?? "",
            ...("credentialUri" in h
              ? { credentialUri: h.credentialUri }
              : {
                  actorJwt: create(ActorJwtSourceSchema, {
                    audiences: h.actorJwt.audiences,
                    expirationSeconds: BigInt(h.actorJwt.expirationSeconds),
                  }),
                }),
          }),
        ),
      })
    : undefined;
  const init = { hostnames: rule.hostnames, ports, effects };
  return create(
    EgressRuleSchema,
    rule.kind === "http" ? { http: create(HttpRuleSchema, init) } : { https: create(HttpsRuleSchema, init) },
  );
}

function ref(atespace: string, name: string) {
  return create(ObjectRefSchema, { atespace, name });
}

type Handlers<T> = Partial<Record<Code, () => T>>;

class GrpcSubstrateApi implements SubstrateApi {
  constructor(private readonly control: Client<typeof Control>) {}

  /**
   * Runs one RPC. A handler registered for the failure's gRPC code decides the outcome (return
   * a value or throw a typed error); any other failure becomes a fixed-message unavailable error.
   */
  private async call<T>(fn: () => Promise<T>, handlers: Handlers<T> = {}): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const code = codeOf(error);
      const handler = code === undefined ? undefined : handlers[code];
      if (handler) return handler();
      throw unavailable();
    }
  }

  async ensureActorTemplate(spec: ActorTemplateSpec): Promise<void> {
    const template = create(ActorTemplateSchema, {
      metadata: create(ResourceMetadataSchema, { atespace: spec.atespace, name: spec.name }),
      ...(spec.workerSelector ? { workerSelector: create(SelectorSchema, { matchLabels: spec.workerSelector }) } : {}),
      containers: spec.containers.map((c) =>
        create(ContainerSchema, {
          name: c.name,
          image: c.image,
          command: c.command ?? [],
          env: (c.env ?? []).map((e) => create(EnvVarSchema, e)),
          ...(c.wakeupProbe
            ? {
                wakeupProbe: create(WakeupProbeSchema, {
                  httpGet: create(HttpGetActionSchema, c.wakeupProbe),
                }),
              }
            : {}),
          volumeMounts: (c.volumeMounts ?? []).map((m) => create(VolumeMountSchema, m)),
        }),
      ),
      volumes: spec.volumes.map(volumeToWire),
      snapshotConfig: create(SnapshotConfigSchema, {
        preferredFidelity: spec.snapshotFidelity === "MEMORY" ? SnapshotFidelity.MEMORY : SnapshotFidelity.VOLUMES,
      }),
      resources: create(ResourceRequirementsSchema, {
        limits: create(ResourcesSchema, {
          cpuMillicores: BigInt(spec.cpuMillicores),
          memoryBytes: BigInt(spec.memoryBytes),
        }),
      }),
    });
    await this.call(
      async () => {
        await this.control.createActorTemplate(create(CreateActorTemplateRequestSchema, { actorTemplate: template }));
      },
      { [Code.AlreadyExists]: () => undefined },
    );
  }

  async getActorTemplate(atespace: string, name: string): Promise<TemplateInfo | undefined> {
    return this.call<TemplateInfo | undefined>(
      async () => {
        const template = await this.control.getActorTemplate(
          create(GetActorTemplateRequestSchema, { actorTemplate: ref(atespace, name) }),
        );
        // Only whether the build failed or is done: neither the error message nor the tag is read out.
        const golden = template.status?.goldenSnapshotStatus;
        const info: TemplateInfo = { goldenSnapshotFailed: (golden?.errorMessage ?? "") !== "" };
        if (golden) info.goldenSnapshotReady = (golden.goldenTag?.name ?? "") !== "";
        return info;
      },
      { [Code.NotFound]: () => undefined },
    );
  }

  async deleteActorTemplate(atespace: string, name: string): Promise<void> {
    await this.call(
      async () => {
        await this.control.deleteActorTemplate(
          create(DeleteActorTemplateRequestSchema, { actorTemplate: ref(atespace, name) }),
        );
      },
      { [Code.NotFound]: () => undefined },
    );
  }

  async createActor(atespace: string, name: string, template: string): Promise<void> {
    // The actor's name is metadata.name (CreateActorRequest carries only the Actor).
    const actor = create(ActorSchema, {
      metadata: create(ResourceMetadataSchema, { atespace, name }),
      actorTemplate: ref(atespace, template),
    });
    await this.call(
      async () => {
        await this.control.createActor(create(CreateActorRequestSchema, { actor }));
      },
      {
        [Code.AlreadyExists]: () => {
          throw new SubstrateAlreadyExistsError("substrate_already_exists");
        },
        // The actor's template is gone (a sweep removed it, or it never existed): Substrate answers
        // FailedPrecondition. The launcher ensures it again; NotFound is kept for the same case.
        [Code.FailedPrecondition]: templateMissing,
        [Code.NotFound]: () => {
          throw new SubstrateNotFoundError("substrate_not_found");
        },
      },
    );
  }

  async getActor(atespace: string, name: string): Promise<ActorInfo | undefined> {
    return this.call<ActorInfo | undefined>(
      async () => {
        const actor = await this.control.getActor(create(GetActorRequestSchema, { actor: ref(atespace, name) }));
        const workerPod = actor.status?.workerAssignment?.workerPod;
        return {
          state: STATE_NAMES[actor.status?.state ?? WireActorState.UNSPECIFIED] ?? "UNKNOWN",
          templateName: actor.actorTemplate?.name ?? "",
          ...(workerPod ? { workerPod } : {}),
        };
      },
      { [Code.NotFound]: () => undefined },
    );
  }

  async resumeActor(atespace: string, name: string): Promise<void> {
    await this.call(
      async () => {
        await this.control.resumeActor(create(ResumeActorRequestSchema, { actor: ref(atespace, name) }));
      },
      {
        [Code.ResourceExhausted]: () => {
          throw new SubstrateExhaustedError("substrate_resource_exhausted");
        },
        // The actor's template is gone (deleted while the actor was suspended).
        [Code.FailedPrecondition]: templateMissing,
        [Code.NotFound]: () => {
          throw new SubstrateNotFoundError("substrate_not_found");
        },
      },
    );
  }

  async suspendActor(atespace: string, name: string): Promise<void> {
    await this.call(
      async () => {
        await this.control.suspendActor(
          create(SuspendActorRequestSchema, {
            actor: ref(atespace, name),
            options: create(SuspendOptionsSchema, { mode: DurabilityMode.SYNCHRONOUS }),
          }),
        );
      },
      {
        [Code.NotFound]: () => {
          throw new SubstrateNotFoundError("substrate_not_found");
        },
      },
    );
  }

  async deleteActor(atespace: string, name: string): Promise<void> {
    await this.call(
      async () => {
        await this.control.deleteActor(create(DeleteActorRequestSchema, { actor: ref(atespace, name) }));
      },
      { [Code.NotFound]: () => undefined },
    );
  }

  async putEgressPolicy(atespace: string, actor: string, rules: EgressRule[]): Promise<void> {
    await this.call(
      async () => {
        await this.control.createActorEgressPolicy(
          create(CreateActorEgressPolicyRequestSchema, {
            actor: ref(atespace, actor),
            egressPolicy: create(EgressPolicySchema, {
              metadata: create(ResourceMetadataSchema, { atespace, name: EGRESS_POLICY_NAME }),
              rules: rules.map(ruleToWire),
            }),
          }),
        );
      },
      { [Code.AlreadyExists]: () => undefined },
    );
  }

  async deleteEgressPolicy(atespace: string, actor: string): Promise<void> {
    await this.call(
      async () => {
        await this.control.deleteActorEgressPolicy(
          create(DeleteActorEgressPolicyRequestSchema, {
            actor: ref(atespace, actor),
            name: EGRESS_POLICY_NAME,
          }),
        );
      },
      { [Code.NotFound]: () => undefined },
    );
  }

  async listWorkers(): Promise<WorkerInfo[]> {
    return this.call(async () => {
      const out: WorkerInfo[] = [];
      let pageToken = "";
      do {
        const page = await this.control.listWorkers(
          create(ListWorkersRequestSchema, { options: { pageSize: 0, pageToken } }),
        );
        for (const w of page.workers) {
          const cap = w.status?.capacity;
          const used = w.status?.allocated;
          const free = (total: bigint | undefined, taken: bigint | undefined) => {
            const left = (total ?? 0n) - (taken ?? 0n);
            return Number(left > 0n ? left : 0n);
          };
          out.push({
            pool: w.workerPool,
            labels: { ...w.labels },
            freeCpuMillicores: free(cap?.cpuMillicores, used?.cpuMillicores),
            freeMemoryBytes: free(cap?.memoryBytes, used?.memoryBytes),
          });
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    });
  }
}
