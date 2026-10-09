import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ServerSummary } from "../api/client";
import type { GraphRun } from "../api/types";
import type { InfraBar } from "../chrome/TopBar";
import { describe, platformOf, type PodView } from "./adapter";
import { useEndedRuns } from "./endedRuns";
import { platformLabel } from "./format";
import { InfraFooter } from "./InfraFooter";
import { InfraView, type InfraMode } from "./InfraView";
import { runSha } from "./runSha";
import { useCluster } from "./useCluster";

const RUN_NOTE = "That run is not in the selected time window.";
const POD_NOTE = "No pod for this run — finished runs' pods are removed.";

interface Props {
  server: ServerSummary;
  runs: readonly GraphRun[];
  /** The chosen kube context was saved for the server: reload the server list. */
  onContextSaved?: () => void;
  /** The top bar, given the Infrastructure controls it should show. */
  topBar: (infra: InfraBar) => ReactNode;
  /** Switch to the Runs tab with this run selected. */
  onOpenRun: (runId: string) => void;
  onRetry: () => void;
  /** A run whose pod should be selected (by run sha) as soon as the cluster data has it. */
  pendingRunSha: string | null;
  /** The pending request was resolved (or abandoned): clear it. */
  onPendingRunSha: () => void;
  /** Widen the Runs window to 7d; false when it already covers that much. */
  widenWindow: () => boolean;
  /** The window the latest runs snapshot was fetched for. */
  loadedWindow: string | null;
  /** Loading the runs failed. */
  loadError: boolean;
}

/** The Infrastructure tab: owns the cluster watch, so it only runs while the tab is open. */
const NO_PODS: PodView[] = [];

export function InfraScreen({
  server,
  runs,
  onContextSaved,
  topBar,
  onOpenRun,
  onRetry,
  pendingRunSha,
  onPendingRunSha,
  widenWindow,
  loadedWindow,
  loadError,
}: Props) {
  const cluster = useCluster(server, { onContextSaved });
  const [mode, setMode] = useState<InfraMode>("map");
  const [selectedPod, setSelectedPod] = useState<string | null>(null);
  // A note under the tab: that run is not loaded, or that run has no pod.
  const [note, setNote] = useState<string | null>(null);
  // Set after widening the window: the run to open once the wider load has arrived.
  const [waiting, setWaiting] = useState<{ sha: string; chars: number } | null>(null);

  const { info } = cluster;
  // Warm pool pods a run claimed carry no run label: the runs name them.
  // Keyed by content: live events replace `runs` often, but the claims rarely change.
  const warmKey = JSON.stringify(runs.flatMap((r) => (r.warmWorkerName ? [[r.warmWorkerName, r.id]] : [])));
  const warmRuns = useMemo(() => new Map(JSON.parse(warmKey) as [string, string][]), [warmKey]);
  const opts = useMemo(
    () => ({ serverUrl: server.url, context: cluster.context, warmRuns }),
    [server.url, cluster.context, warmRuns],
  );
  const model = useMemo(
    () => (info?.kubernetes && !cluster.error ? describe(cluster.cluster, info, opts) : null),
    [cluster.cluster, cluster.error, info, opts],
  );
  const platform = info ? platformOf(info, cluster.cluster, opts) : "generic";
  // Kept here, not in the Map, so an ended run survives the Map remounting (Map/Table, reconnects).
  const runPods = useMemo(
    () => (model ? [...model.groups.codingRuns, ...model.groups.agentSandboxes] : NO_PODS),
    [model],
  );
  const endedRuns = useEndedRuns(runPods, !!model && cluster.cluster.podsSynced);

  const findRun = useCallback(
    async (sha: string, chars: number) => {
      for (const r of runs) if ((await runSha(r.id, chars)) === sha) return r.id;
      return null;
    },
    [runs],
  );

  const openRun = useCallback(
    async (pod: PodView) => {
      if (pod.runId) {
        setNote(null);
        onOpenRun(pod.runId);
        return;
      }
      const sha = pod.runSha;
      if (!sha) return;
      const chars = info?.kubernetes?.runLabelHashChars ?? 40;
      const id = await findRun(sha, chars);
      if (id) {
        setNote(null);
        onOpenRun(id);
      } else if (widenWindow()) {
        setNote(null);
        setWaiting({ sha, chars });
      } else {
        setNote(RUN_NOTE);
      }
    },
    [info, findRun, onOpenRun, widenWindow],
  );

  // Wait for the 7d snapshot itself (live events also change `runs`); give up if the load failed.
  if (waiting && loadError) {
    setWaiting(null);
    setNote(RUN_NOTE);
  }
  useEffect(() => {
    if (!waiting) return;
    if (loadedWindow !== "7d") return;
    let active = true;
    void findRun(waiting.sha, waiting.chars).then((id) => {
      if (!active) return;
      setWaiting(null);
      if (id) onOpenRun(id);
      else setNote(RUN_NOTE);
    });
    return () => {
      active = false;
    };
  }, [waiting, loadedWindow, findRun, onOpenRun]);

  // Run -> pod: select the run's pod (coding run or agent sandbox) once the pods have loaded.
  // A claimed warm pod has no run label, so hash the runs that name one to match the request.
  const [warmShas, setWarmShas] = useState<{ of: typeof warmRuns; byRun: ReadonlyMap<string, string> } | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([...warmRuns].map(async ([pod, id]) => [await runSha(id), pod] as const)).then((pairs) => {
      if (active) setWarmShas({ of: warmRuns, byRun: new Map(pairs) });
    });
    return () => {
      active = false;
    };
  }, [warmRuns]);
  const loadedPods = Boolean(model) && cluster.cluster.connected && cluster.cluster.podsSynced;
  const [handled, setHandled] = useState<string | null>(null);
  if (!pendingRunSha && handled) setHandled(null);
  const warmReady = warmShas?.of === warmRuns;
  if (pendingRunSha && pendingRunSha !== handled && model && loadedPods && warmReady) {
    setHandled(pendingRunSha);
    const warmPod = warmShas.byRun.get(pendingRunSha);
    const pod = runPods.find((p) => (p.runSha ? pendingRunSha.startsWith(p.runSha) : p.name === warmPod));
    if (pod) setSelectedPod(pod.name);
    setNote(pod ? null : POD_NOTE);
  }
  useEffect(() => {
    if (pendingRunSha && pendingRunSha === handled) onPendingRunSha();
  }, [pendingRunSha, handled, onPendingRunSha]);

  return (
    <>
      {topBar({
        mode,
        onModeChange: setMode,
        context: cluster.context,
        contexts: cluster.contexts?.contexts ?? [],
        onContextChange: cluster.setContext,
        platformLabel: platformLabel(platform, info),
        namespace: info?.kubernetes?.namespace ?? null,
        watching: cluster.cluster.connected && !cluster.error,
      })}
      <main className="main">
        {note && <p className="muted">{note}</p>}
        {cluster.contextError && (
          <p className="muted">{`Couldn't save the kube context for this server: ${cluster.contextError}`}</p>
        )}
        <InfraView
          cluster={cluster}
          model={model}
          endedRuns={endedRuns}
          mode={mode}
          selectedPod={selectedPod}
          onSelectPod={setSelectedPod}
          onOpenRun={(pod) => void openRun(pod)}
          onRetry={onRetry}
        />
      </main>
      <InfraFooter totals={model?.totals ?? null} />
    </>
  );
}
