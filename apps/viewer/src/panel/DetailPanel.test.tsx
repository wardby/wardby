import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphRun, RunDetail } from "../api/types";

const api = vi.hoisted(() => ({ fetchRun: vi.fn(), openUrl: vi.fn() }));
vi.mock("../api/client", async (orig) => ({ ...(await orig<typeof import("../api/client")>()), ...api }));

import { DetailPanel } from "./DetailPanel";

const SECRET_VALUE = "postgres://user:hunter2@db/prod";

function makeRun(overrides: Partial<GraphRun> = {}): GraphRun {
  return {
    id: "run_abcdef123456",
    parentRunId: "run_parent000001",
    agentId: "a1",
    agentName: "builder",
    agentKind: "coding",
    status: "running",
    trigger: { kind: "manual" },
    turns: 6,
    tokensIn: 12000,
    tokensOut: 3400,
    costUsd: 0.42,
    budgetUsd: 1,
    startedAt: new Date(Date.now() - 90_000).toISOString(),
    finishedAt: null,
    heartbeatAt: new Date(Date.now() - 12_000).toISOString(),
    outcomes: [],
    services: [
      { name: "postgres", state: "probing", attempts: 3, reason: null, readyAt: null, failedAt: null, createdAt: "" },
    ],
    ...overrides,
  } as GraphRun;
}

function makeDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  const run = makeRun();
  return {
    ...run,
    model: "claude-sonnet-4-6",
    error: null,
    finalText: null,
    childRunIds: ["run_child0000001"],
    outcomes: [
      {
        kind: "pull_request",
        provider: "github",
        repository: "o/r",
        number: 7,
        url: "https://github.com/o/r/pull/7",
        state: "open",
        at: null,
      },
    ],
    coding: {
      provider: "github",
      repository: "o/r",
      baseRef: "main",
      headRef: "wardby/x",
      queuedAt: null,
      failureCategory: null,
      services: [
        {
          name: "postgres",
          version: "16",
          image: "postgres@sha256:9f2c0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab",
          envNames: ["DATABASE_URL", "PGHOST"],
        },
      ],
    },
    ...overrides,
  } as RunDetail;
}

const known = new Map<string, GraphRun>([
  ["run_child0000001", makeRun({ id: "run_child0000001", agentName: "tester", parentRunId: "run_abcdef123456" })],
  ["run_parent000001", makeRun({ id: "run_parent000001", agentName: "lead", parentRunId: null })],
]);

function setup(run = makeRun(), onSelect = vi.fn()) {
  const view = render(<DetailPanel serverUrl="https://w.example" run={run} runs={known} onSelect={onSelect} />);
  return { onSelect, ...view };
}

beforeEach(() => {
  api.fetchRun.mockReset();
  api.openUrl.mockReset();
  api.fetchRun.mockResolvedValue(makeDetail());
  api.openUrl.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("DetailPanel", () => {
  it("says so when a native run executed in a sandbox container", () => {
    setup(makeRun({ nativeExecutionMode: "sandbox" }));
    expect(screen.getByText("Ran in a sandbox container")).toBeInTheDocument();
  });

  it("links a sandbox run to its pod, and a control-plane run to none", () => {
    const onOpenPod = vi.fn();
    const run = makeRun({ agentKind: "native", codingProvider: null, nativeExecutionMode: "sandbox" });
    const view = render(
      <DetailPanel serverUrl="https://w.example" run={run} runs={known} onSelect={vi.fn()} onOpenPod={onOpenPod} />,
    );
    screen.getByRole("button", { name: "Pod ↗" }).click();
    expect(onOpenPod).toHaveBeenCalledWith(run.id);
    view.rerender(
      <DetailPanel
        serverUrl="https://w.example"
        run={{ ...run, nativeExecutionMode: "control-plane" }}
        runs={known}
        onSelect={vi.fn()}
        onOpenPod={onOpenPod}
      />,
    );
    expect(screen.queryByRole("button", { name: "Pod ↗" })).not.toBeInTheDocument();
  });

  it("shows no execution-mode note for a control-plane run", () => {
    setup(makeRun({ nativeExecutionMode: "control-plane" }));
    expect(screen.queryByText("Ran in a sandbox container")).not.toBeInTheDocument();
  });

  it("highlights the outcome or trigger clicked in the graph", async () => {
    const view = render(
      <DetailPanel
        serverUrl="https://w.example"
        run={makeRun()}
        runs={known}
        onSelect={vi.fn()}
        focus={{ kind: "outcome", index: 0 }}
      />,
    );
    const link = (await screen.findByText("⎇ o/r#7")).closest("li")!;
    expect(link).toHaveClass("focused");
    view.rerender(
      <DetailPanel
        serverUrl="https://w.example"
        run={makeRun()}
        runs={known}
        onSelect={vi.fn()}
        focus={{ kind: "trigger" }}
      />,
    );
    expect(link).not.toHaveClass("focused");
    expect(screen.getByText("manual").closest("p")).toHaveClass("focused");
  });

  it("shows a native run's turn count", async () => {
    setup(makeRun({ agentKind: "native", services: [] }));
    expect(await screen.findByText(/Turn 6 · last activity 12s ago/)).toBeInTheDocument();
  });

  it("says a finished run's service status was not recorded instead of pending", async () => {
    const done = new Date().toISOString();
    setup(makeRun({ status: "succeeded", finishedAt: done, services: [] }));
    expect(await screen.findByText("status not recorded")).toBeInTheDocument();
    expect(screen.queryByText(/pending/)).toBeNull();
  });

  it("shows a live run's unreported service as pending", async () => {
    setup(makeRun({ services: [] }));
    expect(await screen.findByText("○ pending")).toBeInTheDocument();
  });

  it("renders the sections from the run detail", async () => {
    setup();
    expect(await screen.findByText("DATABASE_URL")).toBeInTheDocument();
    expect(api.fetchRun).toHaveBeenCalledWith("https://w.example", "run_abcdef123456");
    expect(screen.getByRole("heading", { name: /builder/ })).toBeInTheDocument();
    expect(screen.getByText(/123456/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.42 of \$1\.00/)).toBeInTheDocument();
    expect(screen.getByText(/12,?000 in/)).toBeInTheDocument();
    // A coding run's turns happen inside its worker: no turn count.
    expect(screen.queryByText(/Turn 6/)).toBeNull();
    expect(screen.getByText(/Last activity 12s ago/)).toBeInTheDocument();
    expect(screen.getByText("o/r#7", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/postgres 16/)).toBeInTheDocument();
    expect(screen.getByText(/probing/)).toBeInTheDocument();
    expect(screen.getByText(/sha256:9f2c0123/)).toBeInTheDocument();
    expect(screen.queryByText(/sha256:9f2c0123456789abcdef0123456789abcdef0123456789abcdef/)).toBeNull();
    expect(screen.getByText("PGHOST")).toBeInTheDocument();
    expect(screen.getByText("tester")).toBeInTheDocument();
    expect(screen.getByText("lead")).toBeInTheDocument();
  });

  it("never shows environment values", async () => {
    // Even if a (buggy) server sent values alongside the names, only names render.
    const d = makeDetail();
    (d.coding!.services[0] as unknown as { envValues: string[] }).envValues = [SECRET_VALUE];
    api.fetchRun.mockResolvedValue(d);
    const { container } = setup();
    await screen.findByText("DATABASE_URL");
    expect(container.textContent).not.toContain("hunter2");
    expect(container.textContent).not.toContain(SECRET_VALUE);
  });

  it("selects a child or the parent on click", async () => {
    const { onSelect } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /tester/ }));
    expect(onSelect).toHaveBeenCalledWith("run_child0000001");
    fireEvent.click(screen.getByRole("button", { name: /lead/ }));
    expect(onSelect).toHaveBeenCalledWith("run_parent000001");
  });

  it("closes on Esc and on the close button", async () => {
    const { onSelect } = setup();
    await screen.findByText("DATABASE_URL");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onSelect).toHaveBeenLastCalledWith(null);
    onSelect.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("opens outcome links through open_url", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: /open/i }));
    expect(api.openUrl).toHaveBeenCalledWith("https://github.com/o/r/pull/7");
  });

  it("offers no Open button for a non-https link", async () => {
    const d = makeDetail();
    // Off GitHub, so there is no link to fall back to either.
    Object.assign(d.outcomes[0]!, { url: "javascript:alert(1)", provider: "gitlab" });
    api.fetchRun.mockResolvedValue(d);
    setup();
    await screen.findByText("DATABASE_URL");
    expect(screen.queryByRole("button", { name: /open/i })).toBeNull();
  });

  it("shows error and final text as plain text, not markup", async () => {
    api.fetchRun.mockResolvedValue(
      makeDetail({ error: "<img src=x onerror=alert(1)> boom", finalText: "<b>done</b>" }),
    );
    const { container } = setup();
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("<img");
    expect(screen.getByText("<b>done</b>")).toBeInTheDocument();
  });

  it("copies the run id", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setup();
    fireEvent.click(await screen.findByRole("button", { name: /copy id/i }));
    expect(writeText).toHaveBeenCalledWith("run_abcdef123456");
  });

  it("shows a fetch error and keeps the live header", async () => {
    api.fetchRun.mockRejectedValue({ kind: "http", message: "server returned HTTP 500", status: 500 });
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("server returned HTTP 500");
    expect(screen.getByRole("heading", { name: /builder/ })).toBeInTheDocument();
  });

  it("discards a stale fetch for the previous selection", async () => {
    let resolveOld: (d: RunDetail) => void = () => {};
    api.fetchRun.mockImplementationOnce(() => new Promise<RunDetail>((r) => (resolveOld = r)));
    const second = makeRun({ id: "run_other0000002", agentName: "other" });
    api.fetchRun.mockResolvedValueOnce(
      makeDetail({ id: "run_other0000002", agentName: "other", childRunIds: [], coding: null, error: "second-error" }),
    );
    const { rerender } = setup();
    rerender(<DetailPanel serverUrl="https://w.example" run={second} runs={known} onSelect={() => {}} />);
    expect(await screen.findByText(/second-error/)).toBeInTheDocument();
    await act(async () => resolveOld(makeDetail({ error: "first-error" })));
    expect(screen.queryByText(/first-error/)).toBeNull();
    expect(screen.getByText(/second-error/)).toBeInTheDocument();
  });

  it("refetches once, debounced 1 s, when the selected run changes", async () => {
    vi.useFakeTimers();
    const { rerender } = setup();
    await act(async () => {});
    expect(api.fetchRun).toHaveBeenCalledTimes(1);
    const live = (turns: number) => makeRun({ turns });
    rerender(<DetailPanel serverUrl="https://w.example" run={live(7)} runs={known} onSelect={() => {}} />);
    rerender(<DetailPanel serverUrl="https://w.example" run={live(8)} runs={known} onSelect={() => {}} />);
    await act(async () => void vi.advanceTimersByTime(900));
    expect(api.fetchRun).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(200));
    expect(api.fetchRun).toHaveBeenCalledTimes(2);
  });

  it("restores focus to the opener when it unmounts", async () => {
    const btn = document.createElement("button");
    document.body.append(btn);
    btn.focus();
    const { unmount } = setup();
    await waitFor(() => expect(document.activeElement).not.toBe(btn));
    unmount();
    expect(document.activeElement).toBe(btn);
    btn.remove();
  });
});

describe("DetailPanel pod link", () => {
  it("shows Pod for coding runs and calls onOpenPod with the run id", () => {
    api.fetchRun.mockResolvedValue(makeDetail());
    const onOpenPod = vi.fn();
    render(
      <DetailPanel serverUrl="https://w" run={makeRun()} runs={new Map()} onSelect={vi.fn()} onOpenPod={onOpenPod} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Pod/ }));
    expect(onOpenPod).toHaveBeenCalledWith("run_abcdef123456");
  });

  it("hides Pod for non-coding runs and without a handler", () => {
    api.fetchRun.mockResolvedValue(makeDetail());
    const { unmount } = render(
      <DetailPanel
        serverUrl="https://w"
        run={makeRun({ agentKind: "native" })}
        runs={new Map()}
        onSelect={vi.fn()}
        onOpenPod={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Pod/ })).not.toBeInTheDocument();
    unmount();
    render(<DetailPanel serverUrl="https://w" run={makeRun()} runs={new Map()} onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Pod/ })).not.toBeInTheDocument();
  });
});
