import { useMemo } from "react";
import type { AppError } from "../api/client";
import type { InfraModel, PodView } from "./adapter";
import type { EndedRun } from "./endedRuns";
import { InfraMap } from "./InfraMap";
import { InfraPanel } from "./InfraPanel";
import { InfraTable } from "./InfraTable";
import { CLUSTER_KINDS, isClusterError, type ClusterError } from "./types";
import type { UseCluster } from "./useCluster";

export type InfraMode = "map" | "table";

function errorText(error: AppError | ClusterError, namespace: string): string {
  if (!isClusterError(error)) {
    // From the wardby server (fetching its infrastructure facts), not the cluster.
    const e = error as AppError;
    return e.kind === "forbidden" ? `This wardby server refused to share its infrastructure: ${e.message}` : e.message;
  }
  const e = error;
  switch (e.kind) {
    case "no_kubeconfig":
      return "No kubeconfig found (~/.kube/config or $KUBECONFIG).";
    case "auth_plugin":
      return `Your cluster sign-in failed: ${e.message}. Run your cloud's login (e.g. \`gcloud auth login\`) and retry.`;
    case "forbidden":
      return `Your Kubernetes account can't list ${e.resource} in ${namespace}. See the README for a read-only Role.`;
    case "namespace_not_found":
      return `Namespace ${e.namespace} was not found in this cluster.`;
    case "unreachable":
      return `Can't reach the cluster: ${e.message}`;
    case "context_not_found":
      return `Kube context ${e.context} was not found in your kubeconfig.`;
    default:
      return e.message || "Something went wrong reading the cluster.";
  }
}

/** Errors on kinds that don't block the view, once per distinct message. */
function notices(cluster: UseCluster["cluster"], blocking: unknown, namespace: string): string[] {
  const out = new Set<string>();
  for (const kind of CLUSTER_KINDS) {
    const e = cluster.kindErrors[kind];
    if (!e || e === blocking) continue;
    // The map shows forbidden Secrets as "Secret names hidden (no access)".
    if (kind === "secret" && e.kind === "forbidden") continue;
    // GCPBackendPolicy only adds Cloud Armor detail; a Role without it just loses that.
    if (kind === "backend_policy" && e.kind === "forbidden") continue;
    out.add(errorText(e, namespace));
  }
  return [...out];
}

interface Props {
  cluster: UseCluster;
  /** The described cluster (computed once by the screen); null until there is one. */
  model: InfraModel | null;
  /** Coding runs whose pods are gone, kept by the screen until closed. */
  endedRuns?: { ended: EndedRun[]; dismiss: (name: string) => void };
  mode: InfraMode;
  selectedPod: string | null;
  onSelectPod: (pod: string | null) => void;
  onOpenRun: (pod: PodView) => void;
  onRetry: () => void;
}

export function InfraView({ cluster: c, model, endedRuns, mode, selectedPod, onSelectPod, onOpenRun, onRetry }: Props) {
  const { info, cluster, context } = c;
  const jobFinishedAt = useMemo(
    () => new Map([...cluster.objects.job.values()].map((j) => [j.name, j.finishedAt])),
    [cluster.objects.job],
  );

  if (c.loading) return <p className="muted">Loading…</p>;
  const namespace = info?.kubernetes?.namespace ?? "";
  // A pod error blocks only until the first pod list; after it the last known pods stay visible.
  const podError = cluster.podsSynced ? null : cluster.kindErrors.pod;
  const error = c.error ?? podError ?? (cluster.connected ? null : cluster.error);
  if (error) {
    return (
      <div className="infra-message">
        <p role="alert" className="error">
          {errorText(error, namespace)}
        </p>
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (info && info.launcher !== "kubernetes") {
    return (
      <p className="muted">This deployment runs coding jobs with Docker / locally, so there is no cluster to show.</p>
    );
  }
  if (!context) {
    return (
      <p className="muted">
        {c.contexts?.contexts.length === 0
          ? "Your kubeconfig has no contexts."
          : "Choose a kube context for this server."}
      </p>
    );
  }
  if (!model) return <p className="muted">Loading…</p>;

  const notes = notices(cluster, error, namespace);

  const { alwaysOn, codingRuns, agentSandboxes, warmPool, jobs } = model.groups;
  const pods = [...alwaysOn, ...codingRuns, ...agentSandboxes, ...warmPool, ...jobs];
  const pod = pods.find((p) => p.name === selectedPod);
  const select = (name: string) => onSelectPod(name === selectedPod ? null : name);

  return (
    <div className="workspace infra-workspace">
      <div className="infra-main">
        {notes.length > 0 && (
          <div className="infra-notices" role="status">
            {notes.map((n) => (
              <p key={n} className="error">
                {n}
              </p>
            ))}
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          </div>
        )}
        {mode === "map" ? (
          <InfraMap
            model={model}
            selected={selectedPod}
            onSelect={select}
            onOpenRun={onOpenRun}
            namespace={namespace}
            jobFinishedAt={jobFinishedAt}
            endedRuns={endedRuns}
          />
        ) : (
          <InfraTable
            model={model}
            selected={selectedPod}
            onSelect={select}
            onOpenRun={onOpenRun}
            jobFinishedAt={jobFinishedAt}
          />
        )}
      </div>
      {pod && (
        <InfraPanel
          pod={pod}
          context={context}
          namespace={namespace}
          onOpenRun={onOpenRun}
          onClose={() => onSelectPod(null)}
        />
      )}
    </div>
  );
}
