import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ kubePodEvents: vi.fn() }));
vi.mock("../api/client", async (orig) => ({ ...(await orig<typeof import("../api/client")>()), ...api }));

import { describe as describeCluster } from "./adapter";
import { initialCluster } from "./state";
import { gkeCluster, gkeInfo } from "./fixtures";
import type { ClusterState } from "./types";
import { InfraView } from "./InfraView";
import type { UseCluster } from "./useCluster";

beforeEach(() => {
  api.kubePodEvents.mockResolvedValue([]);
});

const base = (over: Partial<UseCluster> = {}): UseCluster => ({
  info: gkeInfo,
  contexts: { current: "ctx", contexts: ["ctx"] },
  context: "ctx",
  setContext: vi.fn(),
  cluster: gkeCluster,
  loading: false,
  error: null,
  contextError: null,
  ...over,
});

const withErrors = (kindErrors: ClusterState["kindErrors"], over: Partial<ClusterState> = {}) =>
  base({ cluster: { ...gkeCluster, kindErrors, ...over } });

const renderView = (cluster: UseCluster, extra: Partial<React.ComponentProps<typeof InfraView>> = {}) =>
  render(
    <InfraView
      cluster={cluster}
      model={
        cluster.info?.kubernetes ? describeCluster(cluster.cluster, cluster.info, { context: cluster.context }) : null
      }
      mode="table"
      selectedPod={null}
      onSelectPod={vi.fn()}
      onOpenRun={vi.fn()}
      onRetry={vi.fn()}
      {...extra}
    />,
  );

describe("InfraView", () => {
  it("shows loading", () => {
    renderView(base({ loading: true, info: null, cluster: initialCluster }));
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("explains a non-Kubernetes launcher", () => {
    renderView(base({ info: { launcher: "docker", kubernetes: null, native: null } }));
    expect(
      screen.getByText("This deployment runs coding jobs with Docker / locally, so there is no cluster to show."),
    ).toBeInTheDocument();
  });

  it("renders the table and the panel for the selected pod", async () => {
    renderView(base(), { selectedPod: "wardby-headroom-5b4a-klmno" });
    expect(screen.getByText("ALWAYS ON")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "wardby-headroom-5b4a-klmno" })).toBeInTheDocument();
    await screen.findByText("No recent events");
  });

  it("selects and deselects a pod", () => {
    const onSelectPod = vi.fn();
    renderView(base(), { onSelectPod });
    fireEvent.click(screen.getByRole("button", { name: /headroom/ }));
    expect(onSelectPod).toHaveBeenCalledWith("wardby-headroom-5b4a-klmno");
  });

  it("toggles off the already selected pod", () => {
    const onSelectPod = vi.fn();
    renderView(base(), { onSelectPod, selectedPod: "wardby-headroom-5b4a-klmno" });
    fireEvent.click(screen.getAllByRole("button", { name: /headroom/ })[0]);
    expect(onSelectPod).toHaveBeenCalledWith(null);
  });

  it.each([
    [{ kind: "no_kubeconfig" }, "No kubeconfig found (~/.kube/config or $KUBECONFIG)."],
    [
      { kind: "auth_plugin", message: "token expired" },
      "Your cluster sign-in failed: token expired. Run your cloud's login (e.g. `gcloud auth login`) and retry.",
    ],
    [
      { kind: "forbidden", resource: "pods" },
      "Your Kubernetes account can't list pods in wardby. See the README for a read-only Role.",
    ],
    [{ kind: "namespace_not_found", namespace: "wardby" }, "Namespace wardby was not found in this cluster."],
    [{ kind: "unreachable", message: "timeout" }, "Can't reach the cluster: timeout"],
    [{ kind: "context_not_found", context: "gone" }, "Kube context gone was not found in your kubeconfig."],
  ] as const)("shows a specific message for %j", (error, text) => {
    const onRetry = vi.fn();
    renderView(base({ error }), { onRetry });
    expect(screen.getByText(text)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("asks for a context when the kubeconfig has no current one", () => {
    renderView(base({ context: null, contexts: { current: null, contexts: ["a", "b"] }, cluster: initialCluster }));
    expect(screen.getByText("Choose a kube context for this server.")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("says when the kubeconfig has no contexts", () => {
    renderView(base({ context: null, contexts: { current: null, contexts: [] }, cluster: initialCluster }));
    expect(screen.getByText("Your kubeconfig has no contexts.")).toBeInTheDocument();
  });

  it("does not word a wardby server 403 as a Kubernetes RBAC problem", () => {
    renderView(base({ error: { kind: "forbidden", message: "missing scope infra:read" } }));
    expect(
      screen.getByText("This wardby server refused to share its infrastructure: missing scope infra:read"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Kubernetes account/)).not.toBeInTheDocument();
  });

  it("names every other kind it could not list, above the data", () => {
    renderView(
      withErrors({
        job: { kind: "forbidden", resource: "jobs" },
        ingress: { kind: "forbidden", resource: "ingresses" },
        secret: { kind: "forbidden", resource: "secrets" },
      }),
    );
    expect(
      screen.getByText("Your Kubernetes account can't list jobs in wardby. See the README for a read-only Role."),
    ).toBeInTheDocument();
    expect(screen.getByText(/can't list ingresses in wardby/)).toBeInTheDocument();
    // Forbidden secrets are shown on the map as hidden names instead.
    expect(screen.queryByText(/can't list secrets/)).not.toBeInTheDocument();
    expect(screen.getByText("ALWAYS ON")).toBeInTheDocument();
  });

  it("shows one notice for the same error on many kinds, and a secrets error that is not 'no access'", () => {
    const down = { kind: "unreachable" as const, message: "timeout" };
    renderView(withErrors({ job: down, service: down, secret: down }));
    expect(screen.getAllByText("Can't reach the cluster: timeout")).toHaveLength(1);
  });

  it("blocks on a pod error before the first pod list, and only notes one after it", () => {
    const down = { kind: "unreachable" as const, message: "timeout" };
    const { unmount } = renderView(withErrors({ pod: down }, { podsSynced: false }));
    expect(screen.getByRole("alert")).toHaveTextContent("Can't reach the cluster: timeout");
    expect(screen.queryByText("ALWAYS ON")).not.toBeInTheDocument();
    unmount();
    renderView(withErrors({ pod: down }));
    expect(screen.getByText("Can't reach the cluster: timeout")).toBeInTheDocument();
    expect(screen.getByText("ALWAYS ON")).toBeInTheDocument();
  });

  it("renders the map when Map is selected", () => {
    renderView(base(), { mode: "map" });
    expect(screen.getByText("Internet")).toBeInTheDocument();
    expect(screen.queryByText("ALWAYS ON")).not.toBeInTheDocument();
  });

  it("stays quiet about a GCPBackendPolicy the Role cannot list, since it is optional", () => {
    renderView(
      withErrors({
        backend_policy: { kind: "forbidden", resource: "gcpbackendpolicies" },
        job: { kind: "forbidden", resource: "jobs" },
      }),
    );
    expect(screen.queryByText(/gcpbackendpolicies/)).not.toBeInTheDocument();
    expect(screen.getByText(/can't list jobs/)).toBeInTheDocument();
  });
});
