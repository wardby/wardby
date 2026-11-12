import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialFilters } from "../state/filters";
import { hhmm } from "../format/time";
import { windowSpend } from "../format/spend";
import { TopBar } from "./TopBar";

describe("windowSpend", () => {
  it("sums costUsd over the runs", () => {
    expect(windowSpend([{ costUsd: 0.01 }, { costUsd: 0.2 }])).toBeCloseTo(0.21);
    expect(windowSpend([])).toBe(0);
  });
});

describe("TopBar spend", () => {
  it("shows the window total next to today's spend", () => {
    render(
      <TopBar
        servers={[]}
        selectedUrl={null}
        onSelectServer={vi.fn()}
        onAddServer={vi.fn()}
        onSignOut={vi.fn()}
        onRemoveServer={vi.fn()}
        live
        reconnecting={false}
        filters={{ ...initialFilters, window: "24h" }}
        onFiltersChange={vi.fn()}
        agents={[]}
        spend={{ todayUsd: 0, groups: [] }}
        windowSpendUsd={0.21}
        rangeRunCount={0}
        onClearRange={vi.fn()}
      />,
    );
    expect(screen.getByText(/24h \$0\.21/)).toBeInTheDocument();
    expect(screen.getByText(/Today \$0(?!\.)/)).toBeInTheDocument();
  });
});

describe("TopBar range chip", () => {
  const renderBar = (timeRange: { from: number; to: number } | null, onClearRange = vi.fn()) => {
    render(
      <TopBar
        servers={[]}
        selectedUrl={null}
        onSelectServer={vi.fn()}
        onAddServer={vi.fn()}
        onSignOut={vi.fn()}
        onRemoveServer={vi.fn()}
        live
        reconnecting={false}
        filters={{ ...initialFilters, timeRange }}
        onFiltersChange={vi.fn()}
        agents={[]}
        spend={null}
        windowSpendUsd={0}
        rangeRunCount={3}
        onClearRange={onClearRange}
      />,
    );
    return onClearRange;
  };

  it("is hidden without a range", () => {
    renderBar(null);
    expect(screen.queryByRole("button", { name: /clear time range/i })).toBeNull();
  });

  it("shows the span and run count, and the cross clears it", () => {
    const from = Date.UTC(2026, 0, 1, 12, 0);
    const to = Date.UTC(2026, 0, 1, 13, 0);
    const clear = renderBar({ from, to });
    expect(screen.getByText(`${hhmm(from)} → ${hhmm(to)} · 3 runs`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /clear time range/i }));
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe("TopBar truncated window total", () => {
  it("marks a lower bound with an explanatory title", () => {
    render(
      <TopBar
        servers={[]}
        selectedUrl={null}
        onSelectServer={vi.fn()}
        onAddServer={vi.fn()}
        onSignOut={vi.fn()}
        onRemoveServer={vi.fn()}
        live
        reconnecting={false}
        filters={{ ...initialFilters, window: "7d" }}
        onFiltersChange={vi.fn()}
        agents={[]}
        spend={{ todayUsd: 0, groups: [] }}
        windowSpendUsd={0.62}
        windowSpendTruncated
        rangeRunCount={0}
        onClearRange={vi.fn()}
      />,
    );
    const el = screen.getByText(/7d ≥\$0\.62/);
    expect(el.getAttribute("title")).toContain("Only the most recent 500 runs are loaded");
  });
});

describe("TopBar tabs", () => {
  const props = {
    servers: [],
    selectedUrl: null,
    onSelectServer: vi.fn(),
    onAddServer: vi.fn(),
    onSignOut: vi.fn(),
    onRemoveServer: vi.fn(),
    live: true,
    reconnecting: false,
    filters: initialFilters,
    onFiltersChange: vi.fn(),
    agents: [],
    spend: null,
    windowSpendUsd: 0,
    rangeRunCount: 0,
    onClearRange: vi.fn(),
  };

  it("shows Runs | Infrastructure and keeps the runs controls on Runs", () => {
    const onTabChange = vi.fn();
    render(<TopBar {...props} tab="runs" onTabChange={onTabChange} />);
    expect(screen.getByRole("button", { name: "Runs" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Infrastructure" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("Search runs")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Infrastructure" }));
    expect(onTabChange).toHaveBeenCalledWith("infra");
  });

  it("offers a Documents tab that drops the runs controls", () => {
    const onTabChange = vi.fn();
    const { rerender } = render(<TopBar {...props} tab="runs" onTabChange={onTabChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Documents" }));
    expect(onTabChange).toHaveBeenCalledWith("documents");
    rerender(<TopBar {...props} tab="documents" onTabChange={onTabChange} />);
    expect(screen.getByRole("button", { name: "Documents" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByLabelText("Search runs")).toBeNull();
  });

  it("replaces the filter row with Map | Table, the cluster line and a context picker on Infrastructure", () => {
    const onModeChange = vi.fn();
    const onContextChange = vi.fn();
    render(
      <TopBar
        {...props}
        tab="infra"
        onTabChange={vi.fn()}
        infra={{
          mode: "table",
          onModeChange,
          context: "ctx-a",
          contexts: ["ctx-a", "ctx-b"],
          onContextChange,
          platformLabel: "GKE Autopilot",
          namespace: "wardby",
          watching: true,
        }}
      />,
    );
    expect(screen.queryByLabelText("Search runs")).not.toBeInTheDocument();
    // The context is shown once, in the picker; the status line leaves it out.
    expect(screen.getByText("GKE Autopilot · ns wardby ·")).toBeInTheDocument();
    expect(screen.queryByText(/ctx-a ·/)).not.toBeInTheDocument();
    expect(screen.getByText("● watching")).toHaveClass("badge", "live");
    expect(screen.getByLabelText("Kube context")).toHaveAttribute("title", "ctx-a");
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    expect(onModeChange).toHaveBeenCalledWith("map");
    fireEvent.change(screen.getByLabelText("Kube context"), { target: { value: "ctx-b" } });
    expect(onContextChange).toHaveBeenCalledWith("ctx-b");
  });

  it("shows disconnected when the watch is down", () => {
    render(
      <TopBar
        {...props}
        tab="infra"
        onTabChange={vi.fn()}
        infra={{
          mode: "table",
          onModeChange: vi.fn(),
          context: "c",
          contexts: ["c"],
          onContextChange: vi.fn(),
          platformLabel: "Kubernetes",
          namespace: "w",
          watching: false,
        }}
      />,
    );
    expect(screen.getByText("Kubernetes · ns w ·")).toBeInTheDocument();
    const dot = screen.getByText("○ disconnected");
    expect(dot).toHaveClass("badge", "offline");
    expect(dot).not.toHaveClass("live");
  });

  it("offers a placeholder when no context is chosen, so the first context can be picked", () => {
    const onContextChange = vi.fn();
    render(
      <TopBar
        {...props}
        tab="infra"
        onTabChange={vi.fn()}
        infra={{
          mode: "table",
          onModeChange: vi.fn(),
          context: null,
          contexts: ["ctx-a", "ctx-b"],
          onContextChange,
          platformLabel: "Kubernetes",
          namespace: "w",
          watching: false,
        }}
      />,
    );
    const picker = screen.getByLabelText("Kube context") as HTMLSelectElement;
    expect(picker.value).toBe("");
    const placeholder = screen.getByRole("option", { name: "Choose a context…" }) as HTMLOptionElement;
    expect(placeholder.selected).toBe(true);
    expect(placeholder.disabled).toBe(true);
    fireEvent.change(picker, { target: { value: "ctx-a" } });
    expect(onContextChange).toHaveBeenCalledWith("ctx-a");
  });
});
