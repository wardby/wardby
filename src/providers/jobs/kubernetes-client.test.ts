import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiException } from "@kubernetes/client-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KubernetesForbiddenError, KubernetesQuotaExceededError } from "./kubernetes-api.js";
import { ClientNodeKubernetesApi } from "./kubernetes-client.js";

// A throwaway kubeconfig so the constructor never reads the operator's real one;
// the API objects are replaced with stubs below, so no request leaves the process.
const KUBECONFIG = `apiVersion: v1
kind: Config
clusters: [{ name: c, cluster: { server: "https://127.0.0.1:1" } }]
users: [{ name: u, user: { token: t } }]
contexts: [{ name: x, context: { cluster: c, user: u } }]
current-context: x
`;

function failing(code: number) {
  return async () => {
    throw new ApiException(code, "boom", `{"kind":"Status","code":${code}}`, {});
  };
}

function client(core: object, apps: object): ClientNodeKubernetesApi {
  const api = new ClientNodeKubernetesApi();
  Object.assign(api as unknown as Record<string, unknown>, { core, apps });
  return api;
}

describe("ClientNodeKubernetesApi reads", () => {
  const saved = process.env.KUBECONFIG;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "wardby-kubeconfig-"));
    writeFileSync(join(dir, "config"), KUBECONFIG);
    process.env.KUBECONFIG = join(dir, "config");
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = saved;
  });

  it("maps a 403 on readDeployment and readEndpoints to KubernetesForbiddenError, keeping the cause", async () => {
    const api = client({ readNamespacedEndpoints: failing(403) }, { readNamespacedDeployment: failing(403) });
    const dep = await api.readDeployment("ns", "d").catch((e: unknown) => e);
    expect(dep).toBeInstanceOf(KubernetesForbiddenError);
    expect((dep as Error).message).toContain("deployments/ns/d");
    expect((dep as Error).cause).toBeInstanceOf(ApiException);
    const ep = await api.readEndpoints("ns", "e").catch((e: unknown) => e);
    expect(ep).toBeInstanceOf(KubernetesForbiddenError);
    expect((ep as Error).message).toContain("endpoints/ns/e");
  });

  it("still returns undefined for a 404 and rethrows other errors unchanged", async () => {
    const api = client({ readNamespacedEndpoints: failing(404) }, { readNamespacedDeployment: failing(500) });
    expect(await api.readEndpoints("ns", "e")).toBeUndefined();
    const dep = await api.readDeployment("ns", "d").catch((e: unknown) => e);
    expect(dep).toBeInstanceOf(ApiException);
    expect((dep as ApiException<unknown>).code).toBe(500);
  });
});

describe("ClientNodeKubernetesApi quota refusals", () => {
  const saved = process.env.KUBECONFIG;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "wardby-kubeconfig-"));
    writeFileSync(join(dir, "config"), KUBECONFIG);
    process.env.KUBECONFIG = join(dir, "config");
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = saved;
  });
  const pod = { metadata: { name: "p" } };
  const refused = (body: string) => async () => {
    throw new ApiException(403, "Forbidden", body, {});
  };

  it("maps a 403 'exceeded quota' on createPod to KubernetesQuotaExceededError without the body", async () => {
    const body = JSON.stringify({
      message:
        "pods is forbidden: exceeded quota: wardby-coding, requested: limits.cpu=2, used: limits.cpu=7, limited: limits.cpu=8",
    });
    const api = client({ createNamespacedPod: refused(body) }, {});
    const error = await api.createPod("ns", pod).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KubernetesQuotaExceededError);
    expect((error as Error).message).toContain("pod/ns/p");
    expect((error as Error).message).not.toContain("limits.cpu");
    expect((error as KubernetesQuotaExceededError).quotaName).toBe("wardby-coding");
    expect((error as Error).cause).toBeInstanceOf(ApiException);
  });

  it("rethrows a 403 that is not a quota refusal unchanged", async () => {
    const api = client({ createNamespacedPod: refused('{"message":"pods is forbidden: no RBAC"}') }, {});
    const error = await api.createPod("ns", pod).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException<unknown>).code).toBe(403);
  });
});
