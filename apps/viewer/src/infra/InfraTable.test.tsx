import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  statesCluster,
} from "./fixtures";
import { InfraTable } from "./InfraTable";

const model = describeCluster(gkeCluster, gkeInfo);

describe("InfraTable", () => {
  it("groups pods under ALWAYS ON, CODING RUNS and JOBS with the column headers", () => {
    render(<InfraTable model={model} selected={null} onSelect={vi.fn()} onOpenRun={vi.fn()} />);
    for (const h of ["ALWAYS ON", "CODING RUNS", "JOBS"]) expect(screen.getByText(h)).toBeInTheDocument();
    for (const c of ["Pod", "Containers", "Status", "CPU / Mem", "Age"]) {
      expect(screen.getByRole("columnheader", { name: c })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: /control-plane/ })).toBeInTheDocument();
    expect(screen.queryByText("unrelated-pod")).not.toBeInTheDocument();
  });

  it("selects a row on click and marks it aria-pressed", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<InfraTable model={model} selected={null} onSelect={onSelect} onOpenRun={vi.fn()} />);
    const row = screen.getByRole("button", { name: /headroom/ });
    expect(row).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("wardby-headroom-5b4a-klmno");
    rerender(
      <InfraTable model={model} selected="wardby-headroom-5b4a-klmno" onSelect={onSelect} onOpenRun={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /headroom/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows runtime beside status and the container names", () => {
    render(<InfraTable model={model} selected={null} onSelect={vi.fn()} onOpenRun={vi.fn()} />);
    const row = screen.getByRole("button", { name: /wardby-run-abc123/ });
    expect(within(row).getByText(/gVisor/)).toBeInTheDocument();
    expect(within(row).getByText("agent")).toBeInTheDocument();
  });

  it("shows the runtime of a sandboxed pod outside the coding runs", () => {
    const sandboxed = clusterOf({
      pod: [
        pod("wardby-coding-proxy-7c9d-fghij", {
          owner: { kind: "ReplicaSet", name: "wardby-coding-proxy-7c9d" },
          runtimeClass: "gvisor",
          containers: [container({ name: "proxy" })],
        }),
      ],
    });
    render(
      <InfraTable model={describeCluster(sandboxed, gkeInfo)} selected={null} onSelect={vi.fn()} onOpenRun={vi.fn()} />,
    );
    expect(within(screen.getByRole("button", { name: /coding-proxy/ })).getByText(/gVisor/)).toBeInTheDocument();
  });

  it("opens the run from a coding-run row without selecting the pod", () => {
    const onOpenRun = vi.fn();
    const onSelect = vi.fn();
    render(<InfraTable model={model} selected={null} onSelect={onSelect} onOpenRun={onOpenRun} />);
    fireEvent.click(screen.getByRole("button", { name: "Open run" }));
    expect(onOpenRun).toHaveBeenCalledWith(expect.objectContaining({ runSha: RUN_SHA }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("filters rows by the filter box", () => {
    render(<InfraTable model={model} selected={null} onSelect={vi.fn()} onOpenRun={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter pods" }), { target: { value: "proxy" } });
    expect(screen.getByRole("button", { name: /coding-proxy/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /headroom/ })).not.toBeInTheDocument();
  });

  it("hides jobs that finished more than an hour ago", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const old = new Map([["wardby-migrate", "2026-10-01T09:00:00Z"]]);
    const { rerender } = render(
      <InfraTable model={model} selected={null} onSelect={vi.fn()} onOpenRun={vi.fn()} jobFinishedAt={old} now={now} />,
    );
    expect(screen.queryByRole("button", { name: /wardby-migrate/ })).not.toBeInTheDocument();
    const recent = new Map([["wardby-migrate", "2026-10-01T11:30:00Z"]]);
    rerender(
      <InfraTable
        model={model}
        selected={null}
        onSelect={vi.fn()}
        onOpenRun={vi.fn()}
        jobFinishedAt={recent}
        now={now}
      />,
    );
    expect(screen.getByRole("button", { name: /wardby-migrate/ })).toBeInTheDocument();
  });

  it("shows an OUTSIDE THE CLUSTER group for an external control plane", () => {
    const kind = describeCluster(kindCluster, kindInfo, { serverUrl: "http://127.0.0.1:18080/mcp" });
    render(<InfraTable model={kind} selected={null} onSelect={vi.fn()} onOpenRun={vi.fn()} />);
    expect(screen.getByText("OUTSIDE THE CLUSTER")).toBeInTheDocument();
    expect(screen.getByText(/127\.0\.0\.1:18080/)).toBeInTheDocument();
  });

  it("has no OUTSIDE THE CLUSTER group on GKE", () => {
    render(<InfraTable model={model} selected={null} onSelect={vi.fn()} onOpenRun={vi.fn()} />);
    expect(screen.queryByText("OUTSIDE THE CLUSTER")).not.toBeInTheDocument();
  });

  it("shows Completed (muted), Failed (red) and Terminating (muted) in the Status column", () => {
    const m = describeCluster(statesCluster, gkeInfo);
    render(<InfraTable model={m} selected={null} onSelect={vi.fn()} onOpenRun={vi.fn()} />);
    expect(within(screen.getByRole("button", { name: /wardby-migrate-1/ })).getByText("Completed")).toHaveClass("idle");
    expect(within(screen.getByRole("button", { name: /wardby-migrate-2/ })).getByText("Failed")).toHaveClass("bad");
    const old = screen.getByRole("button", { name: /wardby-control-plane-old/ });
    expect(within(old).getByText("Terminating")).toHaveClass("idle");
    const dot = within(old).getByText("cloud-sql-proxy").querySelector(".infra-dot")!;
    expect(dot).not.toHaveClass("bad");
  });
});
