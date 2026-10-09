import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSummary } from "../api/client";
import type { InfraInfo } from "../api/types";
import type { ClusterFrame, ClusterPayload } from "./types";

let handler: ((p: ClusterPayload) => void) | null = null;
const calls: string[] = [];
const unlisten = vi.fn();

vi.mock("../api/client", () => ({
  isAppError: (e: unknown) => typeof e === "object" && e !== null && "kind" in e && "message" in e,
  fetchInfra: vi.fn(),
  kubeContexts: vi.fn(),
  setKubeContext: vi.fn(async () => {}),
  kubeConnect: vi.fn(async () => void calls.push("kubeConnect")),
  kubeDisconnect: vi.fn(async () => void calls.push("kubeDisconnect")),
  onCluster: vi.fn(async (cb: (p: ClusterPayload) => void) => {
    calls.push("onCluster");
    handler = cb;
    return unlisten;
  }),
}));

import * as client from "../api/client";
import { useCluster } from "./useCluster";

const server = (kube_context: string | null = null): ServerSummary => ({
  name: "w",
  url: "https://w.example",
  signed_in: true,
  kube_context,
});
const k8sInfo = (): InfraInfo => ({
  launcher: "kubernetes",
  kubernetes: {
    namespace: "wardby",
    platform: "gke",
    runtimeClass: null,
    proxyService: "proxy",
    runLabel: "wardby.io/run-sha256",
    runLabelHashChars: 40,
    componentLabel: {},
    managedByLabel: {},
  },
  native: null,
});
const settle = () => act(async () => {});
const send = (frame: ClusterFrame, srv = "https://w.example") => act(() => handler!({ server: srv, frame }));
const pod = { name: "p1", phase: "Running" };

beforeEach(() => {
  calls.length = 0;
  handler = null;
  vi.clearAllMocks();
  vi.mocked(client.fetchInfra).mockResolvedValue(k8sInfo());
  vi.mocked(client.kubeContexts).mockResolvedValue({ current: "cur", contexts: ["cur", "other"] });
});

describe("useCluster", () => {
  it("fetches infra first and subscribes before kube_connect", async () => {
    renderHook(() => useCluster(server()));
    await settle();
    expect(client.fetchInfra).toHaveBeenCalledWith("https://w.example");
    expect(calls).toEqual(["onCluster", "kubeConnect"]);
    expect(client.kubeConnect).toHaveBeenCalledWith("https://w.example", "cur", "wardby");
  });

  it("never connects when the launcher is not kubernetes", async () => {
    vi.mocked(client.fetchInfra).mockResolvedValue({ launcher: "docker", kubernetes: null, native: null });
    const { result } = renderHook(() => useCluster(server()));
    await settle();
    expect(client.kubeConnect).not.toHaveBeenCalled();
    expect(client.kubeContexts).not.toHaveBeenCalled();
    expect(result.current.info?.launcher).toBe("docker");
    expect(result.current.loading).toBe(false);
  });

  it("prefers the server's saved context over the kubeconfig current", async () => {
    renderHook(() => useCluster(server("saved")));
    await settle();
    expect(client.kubeConnect).toHaveBeenCalledWith("https://w.example", "saved", "wardby");
  });

  it("setContext persists and reconnects", async () => {
    const { result } = renderHook(() => useCluster(server()));
    await settle();
    act(() => result.current.setContext("other"));
    await settle();
    expect(client.setKubeContext).toHaveBeenCalledWith("https://w.example", "other");
    expect(client.kubeDisconnect).toHaveBeenCalledWith("https://w.example");
    expect(client.kubeConnect).toHaveBeenLastCalledWith("https://w.example", "other", "wardby");
    expect(result.current.context).toBe("other");
  });

  it("reports a saved choice so the server list reloads, and a failed save as contextError", async () => {
    const onContextSaved = vi.fn();
    const { result } = renderHook(() => useCluster(server(), { onContextSaved }));
    await settle();
    act(() => result.current.setContext("other"));
    await settle();
    expect(onContextSaved).toHaveBeenCalledTimes(1);
    expect(result.current.contextError).toBeNull();

    vi.mocked(client.setKubeContext).mockRejectedValueOnce({ kind: "storage", message: "disk full" });
    act(() => result.current.setContext("cur"));
    await settle();
    expect(onContextSaved).toHaveBeenCalledTimes(1);
    expect(result.current.contextError).toBe("disk full");
    expect(result.current.context).toBe("cur");
  });

  it("disconnects and unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => useCluster(server()));
    await settle();
    unmount();
    expect(client.kubeDisconnect).toHaveBeenCalledWith("https://w.example");
    expect(unlisten).toHaveBeenCalled();
  });

  it("reduces frames for its server and ignores other servers'", async () => {
    const { result } = renderHook(() => useCluster(server()));
    await settle();
    await send({ type: "snapshot", kind: "pod", items: [pod] });
    await send({ type: "applied", kind: "pod", item: { name: "other-server" } }, "https://x.example");
    expect([...result.current.cluster.objects.pod.keys()]).toEqual(["p1"]);
  });

  it("surfaces a ClusterError from kube_connect", async () => {
    vi.mocked(client.kubeConnect).mockRejectedValueOnce({ kind: "context_not_found", context: "cur" });
    const { result } = renderHook(() => useCluster(server()));
    await settle();
    expect(result.current.error).toEqual({ kind: "context_not_found", context: "cur" });
  });

  it("surfaces a ClusterError from kube_contexts and does not connect", async () => {
    vi.mocked(client.kubeContexts).mockRejectedValue({ kind: "no_kubeconfig" });
    const { result } = renderHook(() => useCluster(server()));
    await settle();
    expect(result.current.error).toEqual({ kind: "no_kubeconfig" });
    expect(client.kubeConnect).not.toHaveBeenCalled();
  });

  it("surfaces a fetch_infra AppError", async () => {
    vi.mocked(client.fetchInfra).mockRejectedValue({ kind: "forbidden", message: "no" });
    const { result } = renderHook(() => useCluster(server()));
    await settle();
    expect(result.current.error).toEqual({ kind: "forbidden", message: "no" });
    expect(result.current.loading).toBe(false);
  });
});
