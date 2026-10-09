import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ kubePodEvents: vi.fn() }));
vi.mock("../api/client", async (orig) => ({ ...(await orig<typeof import("../api/client")>()), ...api }));

import { describe as describeCluster } from "./adapter";
import {
  clusterOf,
  container,
  gkeCluster,
  gkeInfo,
  kindCluster,
  kindInfo,
  pod,
  RUN_SHA,
  twoRunsCluster,
} from "./fixtures";
import { InfraPanel } from "./InfraPanel";

const model = describeCluster(gkeCluster, gkeInfo);
const find = (name: string) =>
  [...model.groups.alwaysOn, ...model.groups.codingRuns, ...model.groups.jobs].find((p) => p.name === name)!;

beforeEach(() => {
  api.kubePodEvents.mockReset();
});

describe("InfraPanel", () => {
  it("shows identity, node and per-container details for an always-on pod", async () => {
    api.kubePodEvents.mockResolvedValue([]);
    render(
      <InfraPanel
        pod={find("wardby-control-plane-6d8f-abcde")}
        context="ctx"
        namespace="wardby"
        onOpenRun={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "wardby-control-plane-6d8f-abcde" })).toBeInTheDocument();
    expect(screen.getByText(/GSA wardby-app@project/)).toBeInTheDocument();
    expect(screen.getByText("node-1")).toBeInTheDocument();
    expect(screen.getByText("cloud-sql-proxy")).toBeInTheDocument();
    expect(
      screen.getByText((text) => text.includes("gcr.io/cloud-sql-connectors/cloud-sql-proxy:2")),
    ).toBeInTheDocument();
    expect(screen.queryByText(/RUN/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /egress/i })).not.toBeInTheDocument();
    await screen.findByText("No recent events");
    expect(api.kubePodEvents).toHaveBeenCalledWith("ctx", "wardby", "wardby-control-plane-6d8f-abcde");
  });

  it("shows RUN, runtime and egress rules for a coding run, and opens the run", async () => {
    api.kubePodEvents.mockResolvedValue([]);
    const onOpenRun = vi.fn();
    render(
      <InfraPanel
        pod={find("wardby-run-abc123")}
        context="ctx"
        namespace="wardby"
        onOpenRun={onOpenRun}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("gVisor")).toBeInTheDocument();
    expect(screen.getByText(/wardby-coding-proxy :8080\/TCP/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /RUN/ }));
    expect(onOpenRun).toHaveBeenCalledWith(expect.objectContaining({ runSha: RUN_SHA }));
    await screen.findByText("No recent events");
  });

  it("shows only the egress of the policies that select this pod, once each", async () => {
    api.kubePodEvents.mockResolvedValue([]);
    const runs = describeCluster(twoRunsCluster, gkeInfo).groups.codingRuns;
    const items = () => within(screen.getByRole("heading", { name: "EGRESS" }).parentElement!).getAllByRole("listitem");
    const { rerender } = render(
      <InfraPanel pod={runs[0]} context="ctx" namespace="wardby" onOpenRun={vi.fn()} onClose={vi.fn()} />,
    );
    expect(items().map((li) => li.textContent)).toEqual(["pods app.kubernetes.io/name=wardby-coding-proxy :8080/TCP"]);
    rerender(<InfraPanel pod={runs[1]} context="ctx" namespace="wardby" onOpenRun={vi.fn()} onClose={vi.fn()} />);
    expect(items()).toHaveLength(2);
    await screen.findByText("No recent events");
  });

  it("shows the runtime of a sandboxed pod that is not a coding run", async () => {
    api.kubePodEvents.mockResolvedValue([]);
    const sandboxed = clusterOf({
      pod: [
        pod("wardby-coding-proxy-7c9d-fghij", {
          owner: { kind: "ReplicaSet", name: "wardby-coding-proxy-7c9d" },
          runtimeClass: "gvisor",
          containers: [container({ name: "proxy" })],
        }),
      ],
    });
    const proxy = describeCluster(sandboxed, gkeInfo).groups.alwaysOn[0];
    render(<InfraPanel pod={proxy} context="ctx" namespace="wardby" onOpenRun={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Runtime")).toBeInTheDocument();
    expect(screen.getByText("gVisor")).toBeInTheDocument();
    await screen.findByText("No recent events");
  });

  it("lists events loaded on open", async () => {
    api.kubePodEvents.mockResolvedValue([
      { at: "2026-10-01T10:00:00Z", kind: "Warning", reason: "BackOff", message: "Back-off restarting" },
    ]);
    render(
      <InfraPanel
        pod={find("wardby-headroom-5b4a-klmno")}
        context="ctx"
        namespace="wardby"
        onOpenRun={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText(/BackOff/)).toBeInTheDocument();
    expect(screen.getByText(/Back-off restarting/)).toBeInTheDocument();
  });

  it("says when events could not be loaded", async () => {
    api.kubePodEvents.mockImplementation(() => Promise.reject({ kind: "forbidden", resource: "events" }));
    render(
      <InfraPanel
        pod={find("wardby-headroom-5b4a-klmno")}
        context="ctx"
        namespace="wardby"
        onOpenRun={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText("Events unavailable.");
  });

  it("closes", async () => {
    api.kubePodEvents.mockResolvedValue([]);
    const onClose = vi.fn();
    render(
      <InfraPanel
        pod={find("wardby-headroom-5b4a-klmno")}
        context="ctx"
        namespace="wardby"
        onOpenRun={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
    await screen.findByText("No recent events");
  });

  it("lists the NetworkPolicies that select the pod", async () => {
    api.kubePodEvents.mockResolvedValue([]);
    const kind = describeCluster(kindCluster, kindInfo);
    const run = kind.groups.codingRuns[0];
    render(<InfraPanel pod={run} context="ctx" namespace="wardby" onOpenRun={vi.fn()} onClose={vi.fn()} />);
    const items = within(screen.getByRole("heading", { name: "NETWORK POLICIES" }).parentElement!).getAllByRole(
      "listitem",
    );
    expect(items.map((li) => li.textContent)).toEqual([
      "default-denyBlocks all traffic to and from every pod, unless another policy allows it.",
      "wardby-run-egressCoding runs can reach the coding proxy on TCP 8080.",
    ]);
    await screen.findByText("No recent events");
  });

  it("has no NETWORK POLICIES section when none selects the pod", async () => {
    api.kubePodEvents.mockResolvedValue([]);
    render(
      <InfraPanel
        pod={find("wardby-headroom-5b4a-klmno")}
        context="ctx"
        namespace="wardby"
        onOpenRun={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("heading", { name: "NETWORK POLICIES" })).not.toBeInTheDocument();
    await screen.findByText("No recent events");
  });
});
