import { describe, expect, it } from "vitest";
import { FAKE_WORKER_SIZE, FakeSubstrateApi } from "./fake-api.js";
import {
  SubstrateAlreadyExistsError,
  SubstrateExhaustedError,
  SubstrateNotFoundError,
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
    await expect(api.createActor("s", "b", "missing")).rejects.toBeInstanceOf(SubstrateNotFoundError);
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
    await api.putEgressPolicy("s", "a", [{ kind: "http", hostnames: ["p"], ports: [8080] }]);
    expect(api.egressPolicies.get("s/a")).toHaveLength(1);
  });
});
