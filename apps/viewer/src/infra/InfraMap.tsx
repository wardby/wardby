import { useEffect, useState } from "react";
import type { InfraModel, PodView } from "./adapter";
import { containerDot, podReadiness } from "./format";
import { openUrl } from "../api/client";
import { useEndedRuns, type EndedRun } from "./endedRuns";
import { visibleJobs } from "./jobs";
import { SANDBOX_BADGE } from "../graph/labels";

interface Props {
  model: InfraModel;
  selected: string | null;
  onSelect: (pod: string) => void;
  onOpenRun: (pod: PodView) => void;
  namespace?: string;
  jobFinishedAt?: ReadonlyMap<string, string | null>;
  now?: number;
  /** Ended coding runs and agent sandboxes from the screen (see endedRuns.ts). */
  endedRuns?: { ended: EndedRun[]; dismiss: (name: string) => void };
}

function Readiness({ pod }: { pod: PodView }) {
  const r = podReadiness(pod);
  return <span className={r.className}>{r.text}</span>;
}

function Containers({ pod, ended = false }: { pod: PodView; ended?: boolean }) {
  return (
    <span className="map-containers">
      {pod.containers.map((c) => (
        <span key={c.name} className="map-container" title={`${c.name}: ${c.reason ?? c.state}`}>
          <span className={`infra-dot ${ended ? "idle" : containerDot(c, pod.terminating)}`} aria-hidden="true" />
          {c.name}
        </span>
      ))}
    </span>
  );
}

function PodCard({
  pod,
  selected,
  onSelect,
  compact,
}: {
  pod: PodView;
  selected: boolean;
  onSelect: () => void;
  compact?: boolean;
}) {
  return (
    <div className={`map-card-wrap${pod.console ? " has-console" : ""}`}>
      <button
        type="button"
        className={`map-card map-pod${compact ? " compact" : ""}`}
        aria-pressed={selected}
        title={pod.name}
        onClick={onSelect}
      >
        <span className="map-title">
          <span>{pod.title}</span>
          <Readiness pod={pod} />
        </span>
        {!compact && <Containers pod={pod} />}
        {!compact && pod.identity && <span className="muted map-identity">{pod.identity}</span>}
      </button>
      <ConsoleLink pod={pod} />
    </div>
  );
}

/** Opens the pod in the cloud console; sits in the card's corner (a link can't nest in the card's button). */
function ConsoleLink({ pod }: { pod: PodView }) {
  if (!pod.console) return null;
  const { url, label } = pod.console;
  return (
    <button
      type="button"
      className="map-console-link"
      aria-label={`${label}: ${pod.title}`}
      title={label}
      onClick={() => void openUrl(url).catch(() => {})}
    >
      ↗
    </button>
  );
}

function Sandbox({
  pod,
  selected,
  onSelect,
  onOpenRun,
  ended,
  onClose,
}: {
  pod: PodView;
  selected: boolean;
  onSelect: () => void;
  onOpenRun: (pod: PodView) => void;
  /** The pod is gone; the card stays until closed (see endedRuns.ts). */
  ended?: { leaving: boolean };
  onClose?: () => void;
}) {
  const runtime = pod.sandboxed && pod.runtime ? pod.runtime : "Pod";
  const label =
    pod.group === "agent_sandbox" ? `Agent sandbox · ${runtime} · ${pod.name}` : `${runtime} sandbox · ${pod.name}`;
  const linked = Boolean(pod.runSha || pod.runId);
  // Pulses like a running run's box on the Runs graph, until the pod ends.
  const active = !ended && !pod.terminating && (pod.phase === "Pending" || pod.phase === "Running");
  const className = `map-sandbox${ended ? " ended" : ""}${ended?.leaving ? " leaving" : ""}`;
  return (
    <div className={className} role="group" aria-label={label}>
      <span className="map-zone-label">{label}</span>
      <div className="map-sandbox-body">
        <div className={`map-card-wrap${pod.console && !ended ? " has-console" : ""}`}>
          <button
            type="button"
            className={`map-card map-pod${active ? " pulse" : ""}`}
            aria-pressed={selected}
            title={pod.name}
            onClick={onSelect}
          >
            <span className="map-title">
              <span>{pod.title}</span>
              {ended ? <span className="muted">Ended</span> : <Readiness pod={pod} />}
            </span>
            <Containers pod={pod} ended={!!ended} />
          </button>
          {!ended && <ConsoleLink pod={pod} />}
        </div>
        {ended && onClose && (
          <button
            type="button"
            className="infra-open-run"
            aria-label={`Close ${pod.title}`}
            title="Close"
            onClick={onClose}
          >
            ×
          </button>
        )}
        {linked && (
          <button
            type="button"
            className="infra-open-run"
            aria-label={`Open run ${pod.title}`}
            title="Open run"
            onClick={() => onOpenRun(pod)}
          >
            Run ↗
          </button>
        )}
      </div>
    </div>
  );
}

/** Sandbox-mode native agent runs, each in its own pod, and the warm pool of idle ones waiting to be claimed. */
function AgentSandboxes({
  sandbox,
  pods,
  warmPool,
  ended,
  selected,
  onSelect,
  onOpenRun,
  onClose,
}: {
  sandbox: NonNullable<InfraModel["agentSandbox"]>;
  pods: PodView[];
  warmPool: PodView[];
  ended: EndedRun[];
  selected: string | null;
  onSelect: (pod: string) => void;
  onOpenRun: (pod: PodView) => void;
  onClose: (name: string) => void;
}) {
  const idle = warmPool.length;
  const size = sandbox.warmPoolSize;
  return (
    <div className="map-fence map-agent-fence" role="group" aria-label="Agent sandboxes">
      <span className="map-zone-label">
        <span className="sandbox-badge" role="img" aria-label={SANDBOX_BADGE.name} title={SANDBOX_BADGE.name}>
          {SANDBOX_BADGE.text}
        </span>{" "}
        Agent sandboxes · one isolated pod per run
      </span>
      {sandbox.elsewhere && (
        <span className="muted">{`They run in namespace ${sandbox.elsewhere}, which this view doesn't watch.`}</span>
      )}
      <div className="map-sandboxes">
        {pods.map((p) => (
          <Sandbox
            key={p.name}
            pod={p}
            selected={selected === p.name}
            onSelect={() => onSelect(p.name)}
            onOpenRun={onOpenRun}
          />
        ))}
        {ended.map((e) => (
          <Sandbox
            key={`ended-${e.pod.name}`}
            pod={e.pod}
            selected={false}
            onSelect={() => {}}
            onOpenRun={onOpenRun}
            ended={{ leaving: e.leaving }}
            onClose={() => onClose(e.pod.name)}
          />
        ))}
        {pods.length === 0 && ended.length === 0 && <span className="muted">No sandboxed runs</span>}
      </div>
      {(idle > 0 || (size ?? 0) > 0) && (
        <div className="map-warm-pool" role="group" aria-label="Warm pool">
          <span className="map-zone-label">
            {size !== null ? `Warm pool · ${idle} of ${size} ready` : `Warm pool · ${idle} ready`}
          </span>
          {warmPool.map((p) => (
            <button
              key={p.name}
              type="button"
              className={`map-warm-pod${p.ready ? " ready" : ""}`}
              aria-pressed={selected === p.name}
              aria-label={`Warm pod ${p.name}: ${p.status}`}
              title={`${p.name} · ${p.status}`}
              onClick={() => onSelect(p.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function InfraMap({
  model,
  selected,
  onSelect,
  onOpenRun,
  namespace,
  jobFinishedAt,
  now: fixedNow,
  endedRuns,
}: Props) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const { alwaysOn, codingRuns, agentSandboxes, warmPool } = model.groups;
  // Owned by InfraScreen in the app; the local fallback keeps the Map usable on its own.
  const local = useEndedRuns(codingRuns, !endedRuns);
  const { ended: allEnded, dismiss } = endedRuns ?? local;
  const ended = allEnded.filter((e) => e.pod.group !== "agent_sandbox");
  const endedAgents = allEnded.filter((e) => e.pod.group === "agent_sandbox");
  const jobs = visibleJobs(model.groups.jobs, jobFinishedAt, fixedNow ?? clock);
  const hosts = [...new Set(model.edge.flatMap((e) => e.hosts))];
  const main = alwaysOn.filter((p) => p.title !== "headroom");
  const headroom = alwaysOn.filter((p) => p.title === "headroom");
  const rules = model.isolation.egressRules;
  const secrets = model.secrets;

  return (
    <div className="infra-map">
      <div className="map-col map-edge-col">
        {model.controlPlane.inCluster ? (
          <>
            <div className={`map-card map-static map-flow${model.edge.length === 0 ? " map-enter" : ""}`}>
              <span className="map-title">Internet</span>
              {hosts.map((h) => (
                <span key={h} className="muted">
                  {h}
                </span>
              ))}
            </div>
            {model.edge.map((e, i) => (
              <div
                key={`${e.label}-${i}`}
                className={`map-card map-static map-flow${e.role ? "" : " map-protection"}${i === model.edge.length - 1 ? " map-enter" : ""}`}
              >
                <span className="map-title">{e.label}</span>
                {e.detail.length > 0 && <span className="muted">{e.detail.join(" · ")}</span>}
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="map-card map-static">
              <span className="map-title">
                {`Control plane · outside the cluster${model.controlPlane.location ? ` · ${model.controlPlane.location}` : ""}`}
              </span>
              <span className="map-arrow">▼ coding proxy</span>
              <span className="map-arrow">▼ run zone</span>
            </div>
            {model.edge.length === 0 && (
              <div className="map-card map-static">
                <span className="map-title">Local — no ingress</span>
              </div>
            )}
            {model.edge.map((e, i) => (
              <div
                key={`${e.label}-${i}`}
                className={`map-card map-static map-flow${e.role ? "" : " map-protection"}${i === model.edge.length - 1 ? " map-enter" : ""}`}
              >
                <span className="map-title">{e.label}</span>
                {e.detail.length > 0 && <span className="muted">{e.detail.join(" · ")}</span>}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="map-zone map-namespace">
        {namespace && <span className="map-zone-label">namespace {namespace}</span>}
        {model.isolation.policies.count > 0 && (
          <details className="map-policies">
            <summary className="map-zone-label">
              {model.isolation.policies.count === 1
                ? "1 NetworkPolicy"
                : `${model.isolation.policies.count} NetworkPolicies`}
              {model.isolation.policies.defaultDeny && " · default deny"}
            </summary>
            <ul>
              {model.isolation.policies.list.map((np) => (
                <li key={np.name}>
                  <span className="map-policy-name">{np.name}</span>
                  <span className="map-policy-intent">{np.intent}</span>
                  <span className="muted map-policy-raw">
                    {np.selects} · {np.rules.join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="map-pods">
          {main.map((p) => (
            <PodCard key={p.name} pod={p} selected={selected === p.name} onSelect={() => onSelect(p.name)} />
          ))}
        </div>
        {(codingRuns.length > 0 || ended.length > 0 || rules.length > 0) && (
          <div className="map-fence">
            {rules.length > 0 && <span className="map-zone-label">NetworkPolicy: {rules.join(", ")}</span>}
            <div className="map-sandboxes">
              {codingRuns.map((p) => (
                <Sandbox
                  key={p.name}
                  pod={p}
                  selected={selected === p.name}
                  onSelect={() => onSelect(p.name)}
                  onOpenRun={onOpenRun}
                />
              ))}
              {ended.map((e) => (
                <Sandbox
                  key={`ended-${e.pod.name}`}
                  pod={e.pod}
                  selected={false}
                  onSelect={() => {}}
                  onOpenRun={onOpenRun}
                  ended={{ leaving: e.leaving }}
                  onClose={() => dismiss(e.pod.name)}
                />
              ))}
              {codingRuns.length === 0 && ended.length === 0 && <span className="muted">No coding runs</span>}
            </div>
          </div>
        )}
        {model.agentSandbox && (
          <AgentSandboxes
            sandbox={model.agentSandbox}
            pods={agentSandboxes}
            warmPool={warmPool}
            ended={endedAgents}
            selected={selected}
            onSelect={onSelect}
            onOpenRun={onOpenRun}
            onClose={dismiss}
          />
        )}
        {headroom.length > 0 && (
          <div className="map-pods map-small">
            {headroom.map((p) => (
              <PodCard key={p.name} pod={p} compact selected={selected === p.name} onSelect={() => onSelect(p.name)} />
            ))}
          </div>
        )}
        {jobs.length > 0 && (
          <>
            <span className="map-zone-label">jobs</span>
            <div className="map-pods map-small">
              {jobs.map((p) => (
                <PodCard
                  key={p.name}
                  pod={p}
                  compact
                  selected={selected === p.name}
                  onSelect={() => onSelect(p.name)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="map-col map-data-col">
        {model.dataStores.map((d) => (
          <div key={d.label} className="map-card map-static">
            <span className="map-title">{d.label}</span>
            {d.detail.length > 0 && <span className="muted">{d.detail.join(" · ")}</span>}
          </div>
        ))}
        {(secrets.source || secrets.names === null) && (
          <div className="map-card map-static">
            <span className="map-title">
              {secrets.names === null
                ? secrets.forbidden
                  ? "Secret names hidden (no access)"
                  : "Secret names unavailable (see the error above)"
                : `${secrets.source ?? "Secrets"} → ${secrets.names.length} Secrets`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
