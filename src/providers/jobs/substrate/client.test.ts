import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import {
  ActorSchema,
  ActorState,
  ActorStatusSchema,
  ActorTemplateSchema,
  ActorTemplateStatusSchema,
  Control,
  GoldenSnapshotStatusSchema,
  ListWorkersResponseSchema,
  ObjectRefSchema,
  ResumeActorResponseSchema,
  WorkerResourcesSchema,
  WorkerSchema,
  WorkerStatusSchema,
  WorkerAssignmentSchema,
  type CreateActorRequest,
  type CreateActorTemplateRequest,
  type DeleteActorTemplateRequest,
  type GetActorTemplateRequest,
  type CreateActorEgressPolicyRequest,
} from "../../../generated/substrate/substrate/ateapi/v1/ateapi_pb.js";
import {
  SubstrateAlreadyExistsError,
  SubstrateExhaustedError,
  SubstrateNotFoundError,
  SubstrateUnavailableError,
  type ActorTemplateSpec,
} from "./api.js";
import { createSubstrateApiFromTransport } from "./client.js";

function control(methods: Record<string, unknown>) {
  return createSubstrateApiFromTransport(createRouterTransport((router) => router.service(Control, methods)));
}

const SECRET = "rrp_fake_secret_value_1234567890";

describe("createSubstrateApi (Connect adapter)", () => {
  it("creates the actor under the given name (actor.metadata.name) from the given template", async () => {
    let seen: CreateActorRequest | undefined;
    const api = control({
      createActor: (request: CreateActorRequest) => {
        seen = request;
        return create(ActorSchema, request.actor);
      },
    });
    await api.createActor("wardby-runs", "wr-0123456789abcdef0123-agent", "tmpl");
    expect(seen?.actor?.metadata?.atespace).toBe("wardby-runs");
    expect(seen?.actor?.metadata?.name).toBe("wr-0123456789abcdef0123-agent");
    expect(seen?.actor?.actorTemplate).toMatchObject({ atespace: "wardby-runs", name: "tmpl" });
  });

  it("reports a template's terminal golden snapshot failure without its message, and a missing template", async () => {
    let asked: GetActorTemplateRequest | undefined;
    const status = (errorMessage: string) =>
      create(ActorTemplateSchema, {
        status: create(ActorTemplateStatusSchema, {
          goldenSnapshotStatus: create(GoldenSnapshotStatusSchema, { errorMessage }),
        }),
      });
    let reply = status(`GoldenActorCrashed: ${SECRET}`);
    const api = control({
      getActorTemplate: (request: GetActorTemplateRequest) => {
        asked = request;
        if (request.actorTemplate?.name === "gone") throw new ConnectError("missing", Code.NotFound);
        return reply;
      },
    });
    const failed = await api.getActorTemplate("s", "t");
    expect(failed).toEqual({ goldenSnapshotFailed: true });
    expect(JSON.stringify(failed)).not.toContain(SECRET);
    expect(asked?.actorTemplate).toMatchObject({ atespace: "s", name: "t" });
    reply = status("");
    expect(await api.getActorTemplate("s", "t")).toEqual({ goldenSnapshotFailed: false });
    reply = create(ActorTemplateSchema, {});
    expect(await api.getActorTemplate("s", "t")).toEqual({ goldenSnapshotFailed: false });
    expect(await api.getActorTemplate("s", "gone")).toBeUndefined();
  });

  it("deletes a template by name; a missing one is success", async () => {
    const deleted: DeleteActorTemplateRequest[] = [];
    const api = control({
      deleteActorTemplate: (request: DeleteActorTemplateRequest) => {
        deleted.push(request);
        if (deleted.length > 1) throw new ConnectError("missing", Code.NotFound);
        return create(ActorTemplateSchema, {});
      },
    });
    await api.deleteActorTemplate("s", "t");
    await api.deleteActorTemplate("s", "t");
    expect(deleted.map((r) => r.actorTemplate?.name)).toEqual(["t", "t"]);
    expect(deleted[0]?.actorTemplate?.atespace).toBe("s");
  });

  it("maps ALREADY_EXISTS on createActor to SubstrateAlreadyExistsError", async () => {
    const api = control({
      createActor: () => {
        throw new ConnectError("exists", Code.AlreadyExists);
      },
    });
    await expect(api.createActor("s", "a", "t")).rejects.toBeInstanceOf(SubstrateAlreadyExistsError);
  });

  it("maps RESOURCE_EXHAUSTED on resumeActor to SubstrateExhaustedError", async () => {
    const api = control({
      resumeActor: () => {
        throw new ConnectError("no room", Code.ResourceExhausted);
      },
    });
    await expect(api.resumeActor("s", "a")).rejects.toBeInstanceOf(SubstrateExhaustedError);
  });

  it("maps NOT_FOUND on createActor to SubstrateNotFoundError with the fixed message", async () => {
    const api = control({
      createActor: () => {
        throw new ConnectError(`template ${SECRET} missing`, Code.NotFound);
      },
    });
    const error = await api.createActor("s", "a", "t").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubstrateNotFoundError);
    expect((error as Error).message).toBe("substrate_not_found");
    expect(String((error as Error).message)).not.toContain(SECRET);
  });

  it("never surfaces the server's message on UNAVAILABLE", async () => {
    const api = control({
      createActor: () => {
        throw new ConnectError(`backend said ${SECRET}`, Code.Unavailable);
      },
    });
    const error = await api.createActor("s", "a", "t").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubstrateUnavailableError);
    expect((error as Error).message).toBe("substrate_unavailable");
    expect(String((error as Error).message)).not.toContain(SECRET);
  });

  it("treats unexpected codes as unavailable with the fixed message", async () => {
    const api = control({
      getActor: () => {
        throw new ConnectError(`denied ${SECRET}`, Code.PermissionDenied);
      },
    });
    await expect(api.getActor("s", "a")).rejects.toMatchObject({ message: "substrate_unavailable" });
  });

  it("treats already-exists templates and policies as success and missing deletes as success", async () => {
    const api = control({
      createActorTemplate: () => {
        throw new ConnectError("x", Code.AlreadyExists);
      },
      createActorEgressPolicy: () => {
        throw new ConnectError("x", Code.AlreadyExists);
      },
      deleteActor: () => {
        throw new ConnectError("x", Code.NotFound);
      },
      deleteActorEgressPolicy: () => {
        throw new ConnectError("x", Code.NotFound);
      },
      getActor: () => {
        throw new ConnectError("x", Code.NotFound);
      },
    });
    const spec: ActorTemplateSpec = {
      atespace: "s",
      name: "t",
      containers: [],
      volumes: [],
      cpuMillicores: 1,
      memoryBytes: 1,
      snapshotFidelity: "VOLUMES",
    };
    await api.ensureActorTemplate(spec);
    await api.putEgressPolicy("s", "a", []);
    await api.deleteActor("s", "a");
    await api.deleteEgressPolicy("s", "a");
    expect(await api.getActor("s", "a")).toBeUndefined();
  });

  it("translates an actor and its state", async () => {
    const api = control({
      getActor: () =>
        create(ActorSchema, {
          actorTemplate: create(ObjectRefSchema, { atespace: "s", name: "tpl" }),
          status: create(ActorStatusSchema, {
            state: ActorState.RUNNING,
            workerAssignment: create(WorkerAssignmentSchema, { workerPod: "pod-1" }),
          }),
        }),
      resumeActor: () => create(ResumeActorResponseSchema, { resumed: true }),
    });
    expect(await api.getActor("s", "a")).toEqual({
      state: "RUNNING",
      templateName: "tpl",
      workerPod: "pod-1",
    });
    await api.resumeActor("s", "a");
  });

  it("builds the template and egress requests from the spec", async () => {
    let template: CreateActorTemplateRequest | undefined;
    let policy: CreateActorEgressPolicyRequest | undefined;
    const api = control({
      createActorTemplate: (req: CreateActorTemplateRequest) => {
        template = req;
        return req.actorTemplate;
      },
      createActorEgressPolicy: (req: CreateActorEgressPolicyRequest) => {
        policy = req;
        return req.egressPolicy;
      },
    });
    await api.ensureActorTemplate({
      atespace: "wardby-runs",
      name: "tpl",
      workerSelector: { pool: "gvisor" },
      containers: [
        {
          name: "main",
          image: "repo@sha256:abc",
          command: ["run"],
          env: [{ name: "A", value: "b" }],
          wakeupProbe: { path: "/healthz", port: 8080 },
          volumeMounts: [{ name: "meta", mountPath: "/meta" }],
        },
      ],
      volumes: [
        { name: "d", durableDir: true },
        { name: "t", trustBundle: { names: ["x"], path: "ca.pem" } },
        { name: "meta", actorMetadata: { path: "actor" } },
      ],
      cpuMillicores: 500,
      memoryBytes: 1024,
      snapshotFidelity: "MEMORY",
    });
    const t = template?.actorTemplate;
    expect(t?.metadata).toMatchObject({ atespace: "wardby-runs", name: "tpl" });
    expect(t?.workerSelector?.matchLabels).toEqual({ pool: "gvisor" });
    expect(t?.containers[0]?.wakeupProbe?.httpGet).toMatchObject({ path: "/healthz", port: 8080 });
    expect(t?.containers[0]?.command).toEqual(["run"]);
    expect(t?.resources?.limits).toMatchObject({ cpuMillicores: 500n, memoryBytes: 1024n });
    expect(t?.snapshotConfig?.preferredFidelity).toBe(3);
    expect(t?.volumes).toHaveLength(3);
    const items = t?.volumes[2]?.systemInfo?.dataSources[0]?.actorMetadata?.items;
    expect(items?.map((i) => i.path)).toEqual(["actor/name", "actor/atespace", "actor/uid"]);

    await api.putEgressPolicy("wardby-runs", "a1", [
      {
        kind: "https",
        hostnames: ["api.example.com"],
        ports: [443],
        replaceHeaders: [
          { header: "authorization", prefix: "Bearer ", actorJwt: { audiences: ["x"], expirationSeconds: 300 } },
        ],
      },
      { kind: "http", hostnames: ["p"] },
    ]);
    expect(policy?.actor).toMatchObject({ atespace: "wardby-runs", name: "a1" });
    expect(policy?.egressPolicy?.metadata?.name).toBe("default");
    const [first, second] = policy?.egressPolicy?.rules ?? [];
    expect(first?.https?.ports?.numbers).toEqual([443]);
    expect(first?.https?.effects?.replaceHeaders[0]?.actorJwt?.expirationSeconds).toBe(300n);
    expect(second?.http?.hostnames).toEqual(["p"]);
  });

  function metadataTemplate(path: string): ActorTemplateSpec {
    return {
      atespace: "wardby-runs",
      name: "tpl",
      containers: [{ name: "main", image: "repo@sha256:abc", volumeMounts: [{ name: "meta", mountPath: "/meta" }] }],
      volumes: [{ name: "meta", actorMetadata: { path } }],
      cpuMillicores: 500,
      memoryBytes: 1024,
      snapshotFidelity: "MEMORY",
    };
  }

  it("refuses an absolute actorMetadata path before any call", async () => {
    let called = false;
    const api = control({
      createActorTemplate: (req: CreateActorTemplateRequest) => {
        called = true;
        return req.actorTemplate;
      },
    });
    const error = await api.ensureActorTemplate(metadataTemplate("/run/ate/actor")).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("substrate_template_invalid");
    expect((error as Error).message).not.toContain("/run/ate/actor");
    expect(called).toBe(false);
  });

  it.each(["..", "../escape", "actor/../..", "actor/.."])(
    "refuses an actorMetadata path with a .. segment before any call: %s",
    async (path) => {
      let called = false;
      const api = control({
        createActorTemplate: (req: CreateActorTemplateRequest) => {
          called = true;
          return req.actorTemplate;
        },
      });
      const error = await api.ensureActorTemplate(metadataTemplate(path)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("substrate_template_invalid");
      expect(called).toBe(false);
    },
  );

  it("accepts an actorMetadata path whose name only contains dots", async () => {
    const api = control({ createActorTemplate: (req: CreateActorTemplateRequest) => req.actorTemplate });
    await api.ensureActorTemplate(metadataTemplate("actor..d/meta"));
  });

  it("puts the files at the volume root for an empty path", async () => {
    let template: CreateActorTemplateRequest | undefined;
    const api = control({
      createActorTemplate: (req: CreateActorTemplateRequest) => {
        template = req;
        return req.actorTemplate;
      },
    });
    await api.ensureActorTemplate(metadataTemplate(""));
    const items = template?.actorTemplate?.volumes[0]?.systemInfo?.dataSources[0]?.actorMetadata?.items;
    expect(items?.map((i) => i.path)).toEqual(["name", "atespace", "uid"]);
  });

  it("lists free worker capacity across pages", async () => {
    const worker = (pool: string, capCpu: bigint, usedCpu: bigint) =>
      create(WorkerSchema, {
        workerPool: pool,
        labels: { pool },
        status: create(WorkerStatusSchema, {
          capacity: create(WorkerResourcesSchema, { cpuMillicores: capCpu, memoryBytes: 100n }),
          allocated: create(WorkerResourcesSchema, { cpuMillicores: usedCpu, memoryBytes: 30n }),
        }),
      });
    const api = control({
      listWorkers: (req: { options?: { pageToken: string } }) =>
        req.options?.pageToken
          ? create(ListWorkersResponseSchema, { workers: [worker("b", 100n, 500n)] })
          : create(ListWorkersResponseSchema, { workers: [worker("a", 1000n, 250n)], nextPageToken: "p2" }),
    });
    expect(await api.listWorkers()).toEqual([
      { pool: "a", labels: { pool: "a" }, freeCpuMillicores: 750, freeMemoryBytes: 70 },
      { pool: "b", labels: { pool: "b" }, freeCpuMillicores: 0, freeMemoryBytes: 70 },
    ]);
  });
});
