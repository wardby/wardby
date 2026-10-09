import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { describe as describeCluster } from "./adapter";
import {
  clusterOf,
  genericCluster,
  genericInfo,
  gkeCluster,
  gkeInfo,
  kindCluster,
  kindInfo,
  pod,
  RUN_SHA,
  statesCluster,
  twoRunsCluster,
} from "./fixtures";
import { InfraMap } from "./InfraMap";

const gke = describeCluster(gkeCluster, gkeInfo);

function renderMap(model = gke, props: Partial<Parameters<typeof InfraMap>[0]> = {}) {
  const onSelect = vi.fn();
  const onOpenRun = vi.fn();
  render(<InfraMap model={model} selected={null} onSelect={onSelect} onOpenRun={onOpenRun} {...props} />);
  return { onSelect, onOpenRun };
}

describe("InfraMap", () => {
  it("shows the Internet, Gateway, Cloud SQL and Secret Manager cards", () => {
    renderMap();
    expect(screen.getByText("Internet")).toBeInTheDocument();
    expect(screen.getByText("wardby.example.com")).toBeInTheDocument();
    expect(screen.getByText("Gateway")).toBeInTheDocument();
    expect(screen.getByText(/Cloud Armor/)).toBeInTheDocument();
    expect(screen.getByText("Cloud SQL")).toBeInTheDocument();
    expect(screen.getByText("Secret Manager → 2 Secrets")).toBeInTheDocument();
  });

  it("labels the egress fence with the NetworkPolicy rules", () => {
    renderMap();
    expect(screen.getByText(/NetworkPolicy: pods app\.kubernetes\.io\/name=wardby-coding-proxy/)).toBeInTheDocument();
  });

  it("draws one sandbox per coding run with its containers", () => {
    renderMap();
    const sandbox = screen.getByRole("group", { name: "gVisor sandbox · wardby-run-abc123" });
    expect(within(sandbox).getByText("agent")).toBeInTheDocument();
  });

  it("pulses an active coding run's card, like a running run on the graph", () => {
    renderMap();
    const sandbox = screen.getByRole("group", { name: "gVisor sandbox · wardby-run-abc123" });
    expect(within(sandbox).getByTitle("wardby-run-abc123")).toHaveClass("pulse");
    expect(screen.getByRole("button", { name: /control-plane/ })).not.toHaveClass("pulse");
  });

  it("keeps an ended coding run on the map, marked Ended, with a close button", () => {
    const props = { selected: null, onSelect: vi.fn(), onOpenRun: vi.fn() };
    const { rerender } = render(<InfraMap model={gke} {...props} />);
    const withoutRun = { ...gke, groups: { ...gke.groups, codingRuns: [] } };
    rerender(<InfraMap model={withoutRun} {...props} />);
    const sandbox = screen.getByRole("group", { name: "gVisor sandbox · wardby-run-abc123" });
    expect(sandbox).toHaveClass("ended");
    expect(within(sandbox).getByText("Ended")).toBeInTheDocument();
    expect(within(sandbox).getByRole("button", { name: /Close/ })).toBeInTheDocument();
  });

  it("lists always-on pods with ready counts, containers and identity", () => {
    renderMap();
    const card = screen.getByRole("button", { name: /control-plane/ });
    expect(within(card).getByText("2/2")).toBeInTheDocument();
    expect(within(card).getByText("cloud-sql-proxy")).toBeInTheDocument();
    expect(within(card).getByText(/GSA wardby-app@/)).toBeInTheDocument();
  });

  it("selects a pod on click and marks it pressed", () => {
    const { onSelect } = renderMap(gke, { selected: "wardby-headroom-5b4a-klmno" });
    expect(screen.getByRole("button", { name: /headroom/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /coding-proxy/ }));
    expect(onSelect).toHaveBeenCalledWith("wardby-coding-proxy-7c9d-fghij");
  });

  it("opens the run from the sandbox arrow without selecting", () => {
    const { onOpenRun, onSelect } = renderMap();
    fireEvent.click(screen.getByRole("button", { name: "Open run wardby-run-abc123" }));
    expect(onOpenRun).toHaveBeenCalledWith(expect.objectContaining({ runSha: RUN_SHA }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("says secret names are hidden only for lack of access", () => {
    renderMap({ ...gke, secrets: { source: "Secret Manager", names: null, forbidden: true } });
    expect(screen.getByText("Secret names hidden (no access)")).toBeInTheDocument();
  });

  it("says secret names are unavailable for any other error", () => {
    renderMap({ ...gke, secrets: { source: "Secret Manager", names: null, forbidden: false } });
    expect(screen.getByText("Secret names unavailable (see the error above)")).toBeInTheDocument();
    expect(screen.queryByText(/no access/)).not.toBeInTheDocument();
  });

  it("lists each egress rule once across per-run policies", () => {
    renderMap(describeCluster(twoRunsCluster, gkeInfo));
    expect(
      screen.getByText(
        "NetworkPolicy: pods app.kubernetes.io/name=wardby-coding-proxy :8080/TCP, cidr 10.0.0.0/8 :443/TCP",
      ),
    ).toBeInTheDocument();
  });

  it("renders the generic platform with Ingress and external Postgres", () => {
    renderMap(describeCluster(genericCluster, genericInfo));
    expect(screen.getByText("Ingress")).toBeInTheDocument();
    expect(screen.getByText("Postgres (external)")).toBeInTheDocument();
    expect(screen.queryByText(/NetworkPolicy/)).not.toBeInTheDocument();
  });

  it("shows the namespace header and hides jobs finished over an hour ago, like the Table", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const old = new Map([["wardby-migrate", "2026-10-01T09:00:00Z"]]);
    const fresh = new Map([["wardby-migrate", "2026-10-01T11:30:00Z"]]);
    const { rerender } = render(
      <InfraMap
        model={gke}
        selected={null}
        onSelect={vi.fn()}
        onOpenRun={vi.fn()}
        namespace="wardby"
        jobFinishedAt={old}
        now={now}
      />,
    );
    expect(screen.getByText("namespace wardby")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /wardby-migrate/ })).not.toBeInTheDocument();
    rerender(
      <InfraMap
        model={gke}
        selected={null}
        onSelect={vi.fn()}
        onOpenRun={vi.fn()}
        namespace="wardby"
        jobFinishedAt={fresh}
        now={now}
      />,
    );
    expect(screen.getByRole("button", { name: /wardby-migrate/ })).toBeInTheDocument();
    expect(screen.getByText("jobs")).toBeInTheDocument();
  });

  it("shows an outside control plane card and a local edge for kind", () => {
    const kind = describeCluster(kindCluster, kindInfo, { serverUrl: "http://127.0.0.1:18080/mcp", context: "kind-x" });
    renderMap(kind);
    expect(screen.getByText("Control plane · outside the cluster · 127.0.0.1:18080")).toBeInTheDocument();
    expect(screen.getByText("Local — no ingress")).toBeInTheDocument();
    expect(screen.queryByText("Internet")).not.toBeInTheDocument();
    expect(screen.getByText("▼ coding proxy")).toBeInTheDocument();
    expect(screen.getByText("▼ run zone")).toBeInTheDocument();
    // Its own labelled arrows only: no extra flow arrow under the card.
    const card = screen.getByText(/^Control plane · outside the cluster/).closest(".map-card");
    expect(card).not.toHaveClass("map-flow");
    expect(screen.getByRole("group", { name: "Pod sandbox · wardby-run-abc123" })).toBeInTheDocument();
  });

  it("hides the location when the server URL is unknown", () => {
    renderMap(describeCluster(kindCluster, kindInfo));
    expect(screen.getByText("Control plane · outside the cluster")).toBeInTheDocument();
  });

  describe("pod state", () => {
    const model = describeCluster(statesCluster, gkeInfo);
    const card = (name: RegExp) => screen.getByRole("button", { name });

    it("shows Completed (muted) instead of 0/n for a finished job pod", () => {
      renderMap(model);
      const c = card(/^wardby-migrateCompleted/);
      const label = within(c).getByText("Completed");
      expect(label).toHaveClass("muted");
      expect(within(c).queryByText(/\d\/\d/)).not.toBeInTheDocument();
    });

    it("shows Failed in red", () => {
      renderMap(model);
      expect(within(card(/^wardby-migrate2Failed/)).getByText("Failed")).toHaveClass("status", "bad");
    });

    it("labels a terminating pod and does not colour its containers as problems", () => {
      renderMap(model);
      const old = screen
        .getAllByRole("button", { name: /control-plane/ })
        .find((b) => within(b).queryByText("Terminating"))!;
      expect(within(old).getByText("Terminating")).toHaveClass("muted");
      const dot = within(old).getByText("cloud-sql-proxy").querySelector(".infra-dot")!;
      expect(dot).not.toHaveClass("bad");
      expect(dot).not.toHaveClass("warn");
    });
  });

  describe("NetworkPolicy line", () => {
    it("always shows a namespace line with the policy count and default deny", () => {
      renderMap(describeCluster(kindCluster, kindInfo));
      expect(screen.getByText("2 NetworkPolicies · default deny")).toBeInTheDocument();
    });

    it("shows each policy's name, plain-English sentence, then the raw rules", () => {
      renderMap(describeCluster(kindCluster, kindInfo));
      const item = screen.getByText("wardby-run-egress").closest("li")!;
      const parts = [...item.children].map((c) => [c.className, c.textContent]);
      expect(parts).toEqual([
        ["map-policy-name", "wardby-run-egress"],
        ["map-policy-intent", "Coding runs can reach the coding proxy on TCP 8080."],
        [
          "muted map-policy-raw",
          "wardby.io/component=coding-run · egress: pods app.kubernetes.io/name=wardby-coding-proxy :8080/TCP",
        ],
      ]);
    });

    it("shows the line without any coding run or egress rule, singular for one policy", () => {
      const c = clusterOf({
        pod: [pod("wardby-headroom-1-a", { owner: { kind: "ReplicaSet", name: "wardby-headroom-1" } })],
        network_policy: [
          {
            name: "p",
            podSelector: { app: "x" },
            policyTypes: ["Ingress"],
            selectsAll: false,
            ingressRules: 1,
            ingress: [],
            egressRules: [],
            egress: [],
          },
        ],
      });
      renderMap(describeCluster(c, gkeInfo));
      expect(screen.getByText("1 NetworkPolicy")).toBeInTheDocument();
      expect(document.querySelector(".map-fence")).toBeNull();
    });

    it("is absent when the namespace has no policies", () => {
      renderMap(describeCluster(genericCluster, genericInfo));
      expect(screen.queryByText(/\bNetworkPolic(?:y|ies)\b/)).not.toBeInTheDocument();
    });
  });
});
