import { useEffect, useState } from "react";
import { kubePodEvents } from "../api/client";
import { formatEventTime } from "../format/time";
import type { PodView } from "./adapter";
import { resources } from "./format";
import type { InfraEvent } from "./types";

interface Props {
  pod: PodView;
  context: string;
  namespace: string;
  onOpenRun: (pod: PodView) => void;
  onClose: () => void;
}

type Events = { pod: string; events: InfraEvent[] | null };

export function InfraPanel({ pod, context, namespace, onOpenRun, onClose }: Props) {
  const [loaded, setLoaded] = useState<Events | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      let events: InfraEvent[] | null = null;
      try {
        events = await kubePodEvents(context, namespace, pod.name);
      } catch {
        // Unavailable (for example no permission to read events).
      }
      if (active) setLoaded({ pod: pod.name, events });
    })();
    return () => {
      active = false;
    };
  }, [context, namespace, pod.name]);

  const events = loaded?.pod === pod.name ? loaded : null;
  const runPod = pod.group === "coding_run" || pod.group === "agent_sandbox";

  return (
    <aside className="detail-panel" aria-label="Pod details">
      <div className="panel-head">
        <h2>{pod.name}</h2>
        <button type="button" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <p>
        {pod.status}
        {runPod && (pod.runSha || pod.runId) && (
          <>
            {" "}
            <button type="button" onClick={() => onOpenRun(pod)}>
              RUN ↗
            </button>
          </>
        )}
      </p>
      <dl className="infra-facts">
        {(pod.sandboxed || runPod) && pod.runtime && (
          <>
            <dt>Runtime</dt>
            <dd>{pod.runtime}</dd>
          </>
        )}
        {pod.node && (
          <>
            <dt>Node</dt>
            <dd>{pod.node}</dd>
          </>
        )}
        {pod.identity && (
          <>
            <dt>Identity</dt>
            <dd>{pod.identity}</dd>
          </>
        )}
      </dl>
      {pod.egress.length > 0 && (
        <section className="panel-section">
          <h3>EGRESS</h3>
          <ul className="panel-list">
            {pod.egress.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
      )}
      {pod.policies.length > 0 && (
        <section className="panel-section">
          <h3>NETWORK POLICIES</h3>
          <ul className="panel-list">
            {pod.policyIntents.map((p) => (
              <li key={p.name}>
                <strong>{p.name}</strong>
                <div>{p.intent}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="panel-section">
        <h3>CONTAINERS</h3>
        <ul className="panel-list">
          {pod.containers.map((c) => (
            <li key={c.name}>
              <strong>{c.name}</strong> <span className="muted">{c.role}</span>
              <div>
                {c.reason ?? c.state}
                {c.restarts > 0 && ` · ${c.restarts} restarts`}
              </div>
              <div className="muted">
                requests {resources(c.requests)} · limits {resources(c.limits)}
              </div>
              <div className="muted">{c.image}</div>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel-section">
        <h3>EVENTS</h3>
        {!loaded || loaded.pod !== pod.name ? (
          <p className="muted">Loading…</p>
        ) : events?.events === null ? (
          <p className="muted">Events unavailable.</p>
        ) : events?.events.length === 0 ? (
          <p className="muted">No recent events</p>
        ) : (
          <ul className="panel-list">
            {events?.events.map((e, i) => (
              <li key={i}>
                <span className={e.kind === "Warning" ? "status warn" : "muted"}>{e.reason}</span> {e.message}
                {e.at && <span className="muted"> · {formatEventTime(Date.parse(e.at))}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
