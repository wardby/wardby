import { useEffect, useState } from "react";
import type { InfraModel, PodView } from "./adapter";
import { visibleJobs } from "./jobs";
import { containerDot, formatAge, podUsage, statusKind } from "./format";

interface Props {
  model: InfraModel;
  selected: string | null;
  onSelect: (pod: string) => void;
  onOpenRun: (pod: PodView) => void;
  /** Finish time by job name; a job finished over an hour ago is hidden. */
  jobFinishedAt?: ReadonlyMap<string, string | null>;
  now?: number;
}

function Row({
  pod,
  selected,
  onSelect,
  onOpenRun,
  now,
}: {
  pod: PodView;
  selected: boolean;
  onSelect: () => void;
  onOpenRun: (pod: PodView) => void;
  now: number;
}) {
  const linked = Boolean(pod.runSha || pod.runId);
  return (
    <div className="infra-row-wrap" role="row">
      <button type="button" className="infra-row" aria-pressed={selected} onClick={onSelect}>
        <span className="infra-cell pod-name" role="cell" title={pod.name}>
          {pod.name}
        </span>
        <span className="infra-cell" role="cell">
          {pod.containers.map((c) => (
            <span key={c.name} className="infra-container" title={`${c.name}: ${c.reason ?? c.state}`}>
              <span className={`infra-dot ${containerDot(c, pod.terminating)}`} aria-hidden="true" />
              {c.name}
            </span>
          ))}
        </span>
        <span className={`infra-cell status ${statusKind(pod)}`} role="cell">
          {pod.status}
          {(pod.sandboxed || pod.group === "coding_run" || pod.group === "agent_sandbox") && pod.runtime && (
            <span className="muted"> · {pod.runtime}</span>
          )}
        </span>
        <span className="infra-cell" role="cell">
          {podUsage(pod)}
        </span>
        <span className="infra-cell" role="cell">
          {formatAge(pod.startedAt, now)}
        </span>
      </button>
      {linked && (
        <button
          type="button"
          className="infra-open-run"
          aria-label="Open run"
          title="Open run"
          onClick={() => onOpenRun(pod)}
        >
          ↗
        </button>
      )}
    </div>
  );
}

export function InfraTable({ model, selected, onSelect, onOpenRun, jobFinishedAt, now: fixedNow }: Props) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const now = fixedNow ?? clock;
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const keep = (p: PodView) => !q || `${p.name} ${p.title} ${p.status}`.toLowerCase().includes(q);
  const sections: [string, PodView[]][] = [
    ["ALWAYS ON", model.groups.alwaysOn],
    ["CODING RUNS", model.groups.codingRuns],
    ...(model.agentSandbox
      ? ([
          ["AGENT SANDBOXES", model.groups.agentSandboxes],
          ["WARM POOL", model.groups.warmPool],
        ] as [string, PodView[]][])
      : []),
    ["JOBS", visibleJobs(model.groups.jobs, jobFinishedAt, now)],
  ];

  return (
    <div className="infra-table">
      <input
        type="search"
        aria-label="Filter pods"
        placeholder="filter pods…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div role="table" aria-label="Pods">
        <div className="infra-head" role="row">
          {["Pod", "Containers", "Status", "CPU / Mem", "Age"].map((h) => (
            <span key={h} role="columnheader">
              {h}
            </span>
          ))}
        </div>
        {!model.controlPlane.inCluster && (
          <div role="rowgroup">
            <h3 className="infra-group">OUTSIDE THE CLUSTER</h3>
            <div className="infra-row-wrap" role="row">
              <div className="infra-row infra-row-span">
                <span className="infra-cell pod-name" role="cell">
                  control-plane
                  {model.controlPlane.location && <span className="muted"> · {model.controlPlane.location}</span>}
                </span>
              </div>
            </div>
          </div>
        )}
        {sections.map(([title, pods]) => {
          const rows = pods.filter(keep);
          return (
            <div key={title} role="rowgroup">
              <h3 className="infra-group">{title}</h3>
              {rows.length === 0 && <p className="muted infra-empty">None</p>}
              {rows.map((p) => (
                <Row
                  key={p.name}
                  pod={p}
                  selected={selected === p.name}
                  onSelect={() => onSelect(p.name)}
                  onOpenRun={onOpenRun}
                  now={now}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
