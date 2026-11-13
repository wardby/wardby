import { describe, expect, it } from "vitest";
import { FakeSubstrateApi } from "./fake-api.js";
import { SubstrateAlreadyExistsError, SubstrateExhaustedError } from "./api.js";

describe("FakeSubstrateApi", () => {
  it("creates, resumes and deletes actors", async () => {
    const api = new FakeSubstrateApi({ workers: 1 });
    await api.createActor("wardby-runs", "a", "t");
    expect((await api.getActor("wardby-runs", "a"))?.state).toBe("SUSPENDED");
    await api.resumeActor("wardby-runs", "a");
    expect((await api.getActor("wardby-runs", "a"))?.state).toBe("RUNNING");
    await api.deleteActor("wardby-runs", "a");
    expect(await api.getActor("wardby-runs", "a")).toBeUndefined();
    await api.deleteActor("wardby-runs", "a"); // idempotent
  });

  it("rejects a duplicate actor and refuses resume without a free worker", async () => {
    const api = new FakeSubstrateApi({ workers: 1 });
    await api.createActor("s", "a", "t");
    await expect(api.createActor("s", "a", "t")).rejects.toBeInstanceOf(SubstrateAlreadyExistsError);
    await api.createActor("s", "b", "t");
    await api.resumeActor("s", "a");
    await expect(api.resumeActor("s", "b")).rejects.toBeInstanceOf(SubstrateExhaustedError);
  });

  it("records templates and egress policies for assertions", async () => {
    const api = new FakeSubstrateApi({ workers: 2 });
    await api.putEgressPolicy("s", "a", [{ kind: "http", hostnames: ["p"], ports: [8080] }]);
    expect(api.egressPolicies.get("s/a")).toHaveLength(1);
  });
});
