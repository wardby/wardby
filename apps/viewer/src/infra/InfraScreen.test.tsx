import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphRun } from "../api/types";

const api = vi.hoisted(() => ({ kubePodEvents: vi.fn() }));
vi.mock("../api/client", async (orig) => ({ ...(await orig<typeof import("../api/client")>()), ...api }));
const hook = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("./useCluster", () => ({ useCluster: () => hook.value }));

import { gkeCluster, gkeInfo, RUN_SHA, sandboxCluster, sandboxInfo } from "./fixtures";
import { InfraScreen } from "./InfraScreen";
import { runSha } from "./runSha";
import { initialCluster } from "./state";
import type { UseCluster } from "./useCluster";

const server = { name: "S", url: "https://w.example", signed_in: true, kube_context: null };
const live = (over: Partial<UseCluster> = {}): UseCluster => ({
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

const NOTE = "No pod for this run — finished runs' pods are removed.";
const run = (id: string) => ({ id }) as GraphRun;

beforeEach(() => {
  api.kubePodEvents.mockResolvedValue([]);
  hook.value = live();
});

const renderScreen = (props: Partial<React.ComponentProps<typeof InfraScreen>> = {}) =>
  render(
    <InfraScreen
      server={server}
      runs={[]}
      topBar={() => null}
      onOpenRun={vi.fn()}
      onRetry={vi.fn()}
      pendingRunSha={null}
      onPendingRunSha={vi.fn()}
      widenWindow={() => false}
      loadedWindow="1h"
      loadError={false}
      {...props}
    />,
  );

describe("InfraScreen run -> pod", () => {
  it("selects the pod for the pending run and clears the request", async () => {
    const cleared = vi.fn();
    renderScreen({ pendingRunSha: RUN_SHA, onPendingRunSha: cleared });
    expect(await screen.findByRole("heading", { name: "wardby-run-abc123" })).toBeInTheDocument();
    expect(cleared).toHaveBeenCalled();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  it("waits until the cluster data contains the pod", async () => {
    const cleared = vi.fn();
    hook.value = live({ cluster: initialCluster });
    const { rerender } = renderScreen({ pendingRunSha: RUN_SHA, onPendingRunSha: cleared });
    expect(cleared).not.toHaveBeenCalled();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    hook.value = live();
    rerender(
      <InfraScreen
        server={server}
        runs={[]}
        topBar={() => null}
        onOpenRun={vi.fn()}
        onRetry={vi.fn()}
        pendingRunSha={RUN_SHA}
        onPendingRunSha={cleared}
        widenWindow={() => false}
        loadedWindow="1h"
        loadError={false}
      />,
    );
    expect(await screen.findByRole("heading", { name: "wardby-run-abc123" })).toBeInTheDocument();
    expect(cleared).toHaveBeenCalled();
  });

  it("notes when loaded data has no pod for the run", async () => {
    const cleared = vi.fn();
    renderScreen({ pendingRunSha: "f".repeat(40), onPendingRunSha: cleared });
    expect(await screen.findByText(NOTE)).toBeInTheDocument();
    expect(cleared).toHaveBeenCalled();
  });
});

describe("InfraScreen empty namespace", () => {
  it("notes no pod once the pods snapshot arrived empty", async () => {
    const cleared = vi.fn();
    hook.value = live({ cluster: { ...initialCluster, connected: true, podsSynced: true } });
    renderScreen({ pendingRunSha: RUN_SHA, onPendingRunSha: cleared });
    expect(await screen.findByText(NOTE)).toBeInTheDocument();
    expect(cleared).toHaveBeenCalled();
  });

  it("waits while the pods snapshot has not arrived", () => {
    const cleared = vi.fn();
    hook.value = live({ cluster: { ...initialCluster, connected: true } });
    renderScreen({ pendingRunSha: RUN_SHA, onPendingRunSha: cleared });
    expect(cleared).not.toHaveBeenCalled();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });
});

describe("InfraScreen pod -> run", () => {
  it("opens a run in the window", async () => {
    const id = "cmus7t6wd0000hesqosaxwae6";
    const sha = await runSha(id);
    const onOpenRun = vi.fn();
    hook.value = live({
      cluster: {
        ...gkeCluster,
        objects: {
          ...gkeCluster.objects,
          pod: new Map(
            [...gkeCluster.objects.pod].map(([k, p]) => [
              k,
              p.name === "wardby-run-abc123" ? { ...p, labels: { ...p.labels, "wardby.io/run-sha256": sha } } : p,
            ]),
          ),
        },
      },
    });
    renderScreen({ runs: [run(id)], onOpenRun });
    screen.getByRole("button", { name: /^wardby-run-abc123/ }).click();
    await screen.findByRole("heading", { name: "wardby-run-abc123" });
    screen.getByRole("button", { name: /RUN/ }).click();
    await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith(id));
  });

  it("widens the window to 7d, then opens the run once it is loaded", async () => {
    const id = "cmus7t6wd0000hesqosaxwae6";
    const sha = await runSha(id);
    const onOpenRun = vi.fn();
    const widen = vi.fn(() => true);
    hook.value = live({
      cluster: {
        ...gkeCluster,
        objects: {
          ...gkeCluster.objects,
          pod: new Map(
            [...gkeCluster.objects.pod].map(([k, p]) => [
              k,
              p.name === "wardby-run-abc123" ? { ...p, labels: { ...p.labels, "wardby.io/run-sha256": sha } } : p,
            ]),
          ),
        },
      },
    });
    const props = { topBar: () => null, server, onRetry: vi.fn(), onOpenRun, widenWindow: widen };
    const el = (runs: GraphRun[], loadedWindow = "1h", loadError = false) => (
      <InfraScreen
        {...props}
        runs={runs}
        pendingRunSha={null}
        onPendingRunSha={vi.fn()}
        loadedWindow={loadedWindow}
        loadError={loadError}
      />
    );
    const { rerender } = render(el([]));
    screen.getByRole("button", { name: /^wardby-run-abc123/ }).click();
    await screen.findByRole("heading", { name: "wardby-run-abc123" });
    screen.getByRole("button", { name: /RUN/ }).click();
    await waitFor(() => expect(widen).toHaveBeenCalled());
    expect(onOpenRun).not.toHaveBeenCalled();
    expect(screen.queryByText(/not in the selected time window/)).not.toBeInTheDocument();
    await act(async () => rerender(el([run("live-event")])));
    expect(onOpenRun).not.toHaveBeenCalled();
    expect(screen.queryByText(/not in the selected time window/)).not.toBeInTheDocument();
    await act(async () => rerender(el([run(id)], "7d")));
    await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith(id));
  });

  it("keeps the muted note when the widened load still lacks the run", async () => {
    const widen = vi.fn(() => true);
    const props = { topBar: () => null, server, onRetry: vi.fn(), onOpenRun: vi.fn(), widenWindow: widen };
    const el = (runs: GraphRun[], loadedWindow = "1h", loadError = false) => (
      <InfraScreen
        {...props}
        runs={runs}
        pendingRunSha={null}
        onPendingRunSha={vi.fn()}
        loadedWindow={loadedWindow}
        loadError={loadError}
      />
    );
    const { rerender } = render(el([]));
    screen.getByRole("button", { name: /^wardby-run-abc123/ }).click();
    await screen.findByRole("heading", { name: "wardby-run-abc123" });
    screen.getByRole("button", { name: /RUN/ }).click();
    await waitFor(() => expect(widen).toHaveBeenCalled());
    await act(async () => rerender(el([run("other")], "7d")));
    expect(await screen.findByText(/not in the selected time window/)).toBeInTheDocument();
    expect(props.onOpenRun).not.toHaveBeenCalled();
  });

  it("shows the note and gives up when the wider load fails", async () => {
    const widen = vi.fn(() => true);
    const props = { topBar: () => null, server, onRetry: vi.fn(), onOpenRun: vi.fn(), widenWindow: widen };
    const el = (loadError: boolean) => (
      <InfraScreen
        {...props}
        runs={[]}
        pendingRunSha={null}
        onPendingRunSha={vi.fn()}
        loadedWindow="1h"
        loadError={loadError}
      />
    );
    const { rerender } = render(el(false));
    screen.getByRole("button", { name: /^wardby-run-abc123/ }).click();
    await screen.findByRole("heading", { name: "wardby-run-abc123" });
    screen.getByRole("button", { name: /RUN/ }).click();
    await waitFor(() => expect(widen).toHaveBeenCalled());
    await act(async () => rerender(el(true)));
    expect(await screen.findByText(/not in the selected time window/)).toBeInTheDocument();
  });
});

describe("InfraScreen agent sandboxes", () => {
  const id = "cmus7t6wd0000hesqosaxwae7";
  const claimed = { id, warmWorkerName: "wardby-nwarm-2222" } as GraphRun;

  it("opens the run that claimed a warm pod, by the worker name it records", async () => {
    const onOpenRun = vi.fn();
    hook.value = live({ info: sandboxInfo, cluster: sandboxCluster });
    renderScreen({ runs: [claimed], onOpenRun });
    screen.getByRole("button", { name: "Open run wardby-nwarm-2222" }).click();
    await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith(id));
  });

  it("selects a claimed warm pod for its run", async () => {
    const cleared = vi.fn();
    hook.value = live({ info: sandboxInfo, cluster: sandboxCluster });
    renderScreen({ runs: [claimed], pendingRunSha: await runSha(id), onPendingRunSha: cleared });
    expect(await screen.findByRole("heading", { name: "wardby-nwarm-2222" })).toBeInTheDocument();
    expect(cleared).toHaveBeenCalled();
  });
});
