import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { FakeKubernetesApi } from "./fake-kubernetes-api.js";
import { KubernetesAlreadyExistsError, KubernetesConflictError, KubernetesNotFoundError } from "./kubernetes-api.js";

describe("FakeKubernetesApi", () => {
  it("creates, reads, and conflict-checks ConfigMap replacement by resourceVersion", async () => {
    const api = new FakeKubernetesApi();
    const created = await api.createConfigMap("ns", { metadata: { name: "a" }, data: { k: "1" } });
    await expect(api.createConfigMap("ns", { metadata: { name: "a" } })).rejects.toBeInstanceOf(
      KubernetesAlreadyExistsError,
    );
    const updated = await api.replaceConfigMap("ns", "a", { ...created, data: { k: "2" } });
    expect(updated.metadata?.resourceVersion).not.toBe(created.metadata?.resourceVersion);
    await expect(api.replaceConfigMap("ns", "a", { ...created, data: { k: "3" } })).rejects.toBeInstanceOf(
      KubernetesConflictError,
    );
    expect((await api.readConfigMap("ns", "a"))?.data).toEqual({ k: "2" });
  });

  it("treats deletes of missing objects as success and reads of missing objects as undefined", async () => {
    const api = new FakeKubernetesApi();
    await expect(api.deletePod("ns", "missing", 0)).resolves.toBeUndefined();
    await expect(api.deleteSecret("ns", "missing")).resolves.toBeUndefined();
    await expect(api.deleteNetworkPolicy("ns", "missing")).resolves.toBeUndefined();
    expect(await api.readPod("ns", "missing")).toBeUndefined();
  });

  it("routes exec through a per-container handler and returns its exit code", async () => {
    const api = new FakeKubernetesApi();
    await api.createPod("ns", { metadata: { name: "p" }, spec: { containers: [{ name: "keeper" }] } });
    api.onExec = async ({ container, command, stdout }) => {
      stdout?.end(`${container}:${command.join(" ")}`);
      return 0;
    };
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (c: Buffer) => chunks.push(c));
    expect(await api.exec("ns", "p", "keeper", ["echo", "hi"], { stdout: out, timeoutMs: 1000 })).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe("keeper:echo hi");
  });

  it("stores nothing on a dry-run create", async () => {
    const api = new FakeKubernetesApi();
    const pod = { metadata: { name: "wardby-run-x" }, spec: { containers: [] } };
    expect(await api.dryRunCreatePod("wardby-coding", pod)).toEqual(pod);
    expect(await api.readPod("wardby-coding", "wardby-run-x")).toBeUndefined();
  });

  it("rejects an exec into a missing pod or an unknown container", async () => {
    const api = new FakeKubernetesApi();
    await expect(api.exec("ns", "gone", "keeper", ["true"], { timeoutMs: 1000 })).rejects.toBeInstanceOf(
      KubernetesNotFoundError,
    );
    await api.createPod("ns", { metadata: { name: "p" }, spec: { containers: [{ name: "keeper" }] } });
    await expect(api.exec("ns", "p", "worker", ["true"], { timeoutMs: 1000 })).rejects.toBeInstanceOf(
      KubernetesNotFoundError,
    );
  });
});
