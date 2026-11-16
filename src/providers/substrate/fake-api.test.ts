import { describe, expect, it } from "vitest";
import { FAKE_WORKER_SIZE, FakeSubstrateApi } from "./fake-api.js";
import {
  SubstrateAlreadyExistsError,
  SubstrateExhaustedError,
  SubstrateNotFoundError,
  SubstrateTemplateMissingError,
  SubstrateUnavailableError,
  type ActorTemplateSpec,
} from "./api.js";

const template = (name: string, cpuMillicores: number, memoryBytes: number): ActorTemplateSpec => ({
  atespace: "s",
  name,
  containers: [],
  volumes: [],
  cpuMillicores,
  memoryBytes,
  snapshotFidelity: "MEMORY",
});

describe("FakeSubstrateApi", () => {
  it("refuses an actor without a name, so a missing name cannot pass silently", async () => {
    const api = new FakeSubstrateApi({ workers: 1 });
    await api.ensureActorTemplate(template("t", 500, 2 ** 20));
    await expect(api.createActor("s", "", "t")).rejects.toBeInstanceOf(SubstrateUnavailableError);
    expect(api.actors.size).toBe(0);
    await api.createActor("s", "wr-00000000000000000000-agent", "t");
    expect([...api.actors.keys()]).toEqual(["s/wr-00000000000000000000-agent"]);
  });

  it("refuses an egress policy for an actor that does not exist (Substrate's foreign key)", async () => {
    const api = new FakeSubstrateApi({ workers: 1 });
    await api.ensureActorTemplate(template("t", 500, 2 ** 20));
    await expect(api.putEgressPolicy("s", "a", [])).rejects.toBeInstanceOf(SubstrateNotFoundError);
    await api.createActor("s", "a", "t");
    await api.putEgressPolicy("s", "a", []);
    expect(api.egressPolicies.has("s/a")).toBe(true);
    await api.deleteActor("s", "a");
    expect(api.egressPolicies.size).toBe(0);
  });

  it("reports a template's failed golden snapshot until the template is deleted and created again", async () => {
    const api = new FakeSubstrateApi({ workers: 1 });
    expect(await api.getActorTemplate("s", "t")).toBeUndefined();
    await api.ensureActorTemplate(template("t", 500, 2 ** 20));
    expect(await api.getActorTemplate("s", "t")).toEqual({ goldenSnapshotFailed: false });
    api.failGoldenSnapshot("s", "t");
    await api.ensureActorTemplate(template("t", 500, 2 ** 20));
    expect(await api.getActorTemplate("s", "t")).toEqual({ goldenSnapshotFailed: true });
    await api.deleteActorTemplate("s", "t");
    await api.deleteActorTemplate("s", "t"); // idempotent
    await api.ensureActorTemplate(template("t", 500, 2 ** 20));
    expect(await api.getActorTemplate("s", "t")).toEqual({ goldenSnapshotFailed: false });
  });

  it("reports a template's golden-snapshot ready signal only once set, until the template is deleted", async () => {
    const api = new FakeSubstrateApi({ workers: 1 });
    await api.ensureActorTemplate(template("t", 500, 2 ** 20));
    expect(await api.getActorTemplate("s", "t")).not.toHaveProperty("goldenSnapshotReady");
    api.setGoldenSnapshotReady("s", "t", false);
    expect(await api.getActorTemplate("s", "t")).toEqual({ goldenSnapshotFailed: false, goldenSnapshotReady: false });
    api.setGoldenSnapshotReady("s", "t", true);
    expect(await api.getActorTemplate("s", "t")).toEqual({ goldenSnapshotFailed: false, goldenSnapshotReady: true });
    await api.deleteActorTemplate("s", "t");
    await api.ensureActorTemplate(template("t", 500, 2 ** 20));
    expect(await api.getActorTemplate("s", "t")).not.toHaveProperty("goldenSnapshotReady");
  });

  it("creates, resumes and deletes actors", async () => {
    const api = new FakeSubstrateApi({ workers: 1 });
    await api.ensureActorTemplate(template("t", 500, 2 ** 20));
    await api.createActor("s", "a", "t");
    expect((await api.getActor("s", "a"))?.state).toBe("SUSPENDED");
    await api.resumeActor("s", "a");
    expect((await api.getActor("s", "a"))?.state).toBe("RUNNING");
    await api.deleteActor("s", "a");
    expect(await api.getActor("s", "a")).toBeUndefined();
    await api.deleteActor("s", "a"); // idempotent
  });

  it("rejects a duplicate actor and an unknown template", async () => {
    const api = new FakeSubstrateApi({ workers: 1 });
    await api.ensureActorTemplate(template("t", 500, 2 ** 20));
    await api.createActor("s", "a", "t");
    await expect(api.createActor("s", "a", "t")).rejects.toBeInstanceOf(SubstrateAlreadyExistsError);
    await expect(api.createActor("s", "b", "missing")).rejects.toBeInstanceOf(SubstrateTemplateMissingError);
  });

  it("places many actors on one worker by free CPU and memory, and refuses what does not fit", async () => {
    const api = new FakeSubstrateApi({ workers: 1, workerSize: { cpuMillicores: 1000, memoryBytes: 2 ** 30 } });
    await api.ensureActorTemplate(template("cpu", 400, 2 ** 20));
    await api.ensureActorTemplate(template("mem", 100, 2 ** 30));
    for (const name of ["a", "b", "c"]) await api.createActor("s", name, "cpu");
    await api.createActor("s", "m", "mem");
    await api.resumeActor("s", "a");
    await api.resumeActor("s", "b");
    expect(await api.listWorkers()).toEqual([
      { pool: "fake", labels: {}, freeCpuMillicores: 200, freeMemoryBytes: 2 ** 30 - 2 * 2 ** 20 },
    ]);
    await expect(api.resumeActor("s", "c")).rejects.toBeInstanceOf(SubstrateExhaustedError);
    // CPU left, memory not.
    await expect(api.resumeActor("s", "m")).rejects.toBeInstanceOf(SubstrateExhaustedError);
    // A deleted or crashed actor gives its room back.
    await api.deleteActor("s", "a");
    api.setState("s", "b", "CRASHED");
    await api.resumeActor("s", "c");
    expect((await api.listWorkers())[0]?.freeCpuMillicores).toBe(600);
  });

  it("spreads over workers when one is full, with the default size and labels", async () => {
    const api = new FakeSubstrateApi({ workers: 2, workerLabels: { pool: "wardby" } });
    await api.ensureActorTemplate(template("big", FAKE_WORKER_SIZE.cpuMillicores, 2 ** 20));
    await api.createActor("s", "a", "big");
    await api.createActor("s", "b", "big");
    await api.createActor("s", "c", "big");
    await api.resumeActor("s", "a");
    await api.resumeActor("s", "b");
    await expect(api.resumeActor("s", "c")).rejects.toBeInstanceOf(SubstrateExhaustedError);
    expect((await api.listWorkers()).map((w) => [w.labels, w.freeCpuMillicores])).toEqual([
      [{ pool: "wardby" }, 0],
      [{ pool: "wardby" }, 0],
    ]);
  });

  it("records templates and egress policies for assertions", async () => {
    const api = new FakeSubstrateApi({ workers: 2 });
    await api.ensureActorTemplate(template("t", 500, 2 ** 20));
    await api.createActor("s", "a", "t");
    await api.putEgressPolicy("s", "a", [{ kind: "http", hostnames: ["p"], ports: [8080] }]);
    expect(api.egressPolicies.get("s/a")).toHaveLength(1);
  });
});
