import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRun, isAppError, openUrl, type AppError } from "../api/client";
import type { GraphRun, RunDetail } from "../api/types";
import { useClock } from "../graph/clock";
import { triggerLabel } from "../graph/build";
import { formatElapsed, serviceChip, statusGlyph } from "../graph/nodes/RunNode";
import { outcomeLabel } from "../graph/nodes/OutcomeNode";
import { outcomeLink, triggerLink } from "../graph/links";
import type { RunFocus } from "../graph/selection";
import { formatEventTime } from "../format/time";
import { ErrorLine } from "../chrome/ErrorLine";
import { exactUsd, formatUsd } from "../format/money";

/** A live event for the selected run triggers one refetch after this quiet period. */
export const DETAIL_REFETCH_MS = 1000;
const DIGEST_CHARS = 8;
const IMAGE_MAX = 40;

export interface DetailPanelProps {
  serverUrl: string;
  /** The live (event-updated) run from the graph model; the header and cost track it. */
  run: GraphRun;
  /** Every run in the model, to label and enable parent/child links. */
  runs: ReadonlyMap<string, GraphRun>;
  /** Select a run, or `null` to close the panel. */
  onSelect: (id: string | null) => void;
  /** The trigger or outcome clicked in the graph, highlighted and scrolled into view. */
  focus?: RunFocus | null;
  /** Open this run's pod on the Infrastructure tab (coding runs only). */
  onOpenPod?: (runId: string) => void;
}

interface Loaded {
  id: string;
  detail: RunDetail | null;
  error: AppError | null;
}

const shortId = (id: string) => id.slice(-6);

function toAppError(e: unknown): AppError {
  return isAppError(e) ? e : { kind: "network", message: e instanceof Error ? e.message : String(e) };
}

export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** `repo@sha256:<8 chars>…` for digest references; long tags are truncated. */
export function shortImage(image: string): string {
  const at = image.indexOf("@sha256:");
  if (at >= 0) {
    const digest = image.slice(at + "@sha256:".length);
    return `${image.slice(0, at)}@sha256:${digest.slice(0, DIGEST_CHARS)}${digest.length > DIGEST_CHARS ? "…" : ""}`;
  }
  return image.length > IMAGE_MAX ? `${image.slice(0, IMAGE_MAX)}…` : image;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function RunLink({
  id,
  runs,
  onSelect,
}: {
  id: string;
  runs: ReadonlyMap<string, GraphRun>;
  onSelect: (id: string) => void;
}) {
  const known = runs.get(id);
  return (
    <button
      type="button"
      disabled={!known}
      onClick={() => onSelect(id)}
      title={known ? undefined : "Outside the loaded window"}
    >
      <span>{known ? known.agentName : "run"}</span> <span className="node-id">{shortId(id)}</span>
    </button>
  );
}

const focusClass = (on: boolean) => (on ? "focus-item focused" : "focus-item");

export function DetailPanel({ serverUrl, run, runs, onSelect, focus = null, onOpenPod }: DetailPanelProps) {
  const [loaded, setLoaded] = useState<Loaded>({ id: run.id, detail: null, error: null });
  const seq = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const running = run.status === "running";
  const now = useClock(true);
  const trigger = triggerLink(run.trigger);
  const focused = (i: number) => focus?.kind === "outcome" && focus.index === i;
  // Bring the clicked trigger or outcome into view once it has rendered (outcomes wait for the detail).
  const focusRef = useRef<HTMLElement | null>(null);
  const setFocusEl = (el: HTMLElement | null) => {
    focusRef.current = el;
  };

  const discardPending = useCallback(() => {
    seq.current++;
  }, []);

  const load = useCallback(() => {
    const mine = ++seq.current;
    const id = run.id;
    fetchRun(serverUrl, id).then(
      (detail) => {
        if (mine === seq.current) setLoaded({ id, detail, error: null });
      },
      (e: unknown) => {
        if (mine === seq.current)
          setLoaded((l) => ({ id, detail: l.id === id ? l.detail : null, error: toAppError(e) }));
      },
    );
  }, [serverUrl, run.id]);

  // Fetch on selection; a response for a previous selection is discarded.
  useEffect(() => {
    load();
    return discardPending;
  }, [load, discardPending]);

  // Refetch (debounced) when the selected run changes live: an event updated it.
  const signature = JSON.stringify(run);
  const seen = useRef({ id: run.id, signature });
  useEffect(() => {
    const prev = seen.current;
    seen.current = { id: run.id, signature };
    if (prev.id !== run.id || prev.signature === signature) return;
    const timer = setTimeout(load, DETAIL_REFETCH_MS);
    return () => clearTimeout(timer);
  }, [signature, run.id, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onSelect(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onSelect]);

  // Move focus into the panel when it opens and give it back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const current = loaded.id === run.id ? loaded : { id: run.id, detail: null, error: null };
  const detail = current.detail;
  useEffect(() => {
    focusRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [focus, detail]);
  const pct = run.budgetUsd > 0 ? Math.min(100, (run.costUsd / run.budgetUsd) * 100) : 0;
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const elapsed = formatElapsed(end - Date.parse(run.startedAt));

  const snapshots = new Map((detail?.coding?.services ?? []).map((s) => [s.name, s]));
  const serviceNames = [...new Set([...run.services.map((s) => s.name), ...snapshots.keys()])];
  const statuses = new Map(run.services.map((s) => [s.name, s]));
  // A live run's services may not have reported yet; a finished run without a status never recorded one.
  const live = run.status === "pending" || run.status === "running";

  return (
    <aside ref={panelRef} tabIndex={-1} className="detail-panel" aria-label="Run details">
      <header className="panel-head">
        <h2>
          <span role="img" aria-label={run.status}>
            {statusGlyph(run.status)}
          </span>{" "}
          {run.agentName} <span className="node-id">{shortId(run.id)}</span>
        </h2>
        <button type="button" onClick={() => onSelect(null)} aria-label="Close details">
          ✕
        </button>
      </header>
      <p className="muted">
        {run.status} · {elapsed}
        {running ? " elapsed" : ""}
      </p>
      {run.nativeExecutionMode === "sandbox" && <p className="muted">Ran in a sandbox container</p>}
      {current.error && <ErrorLine error={current.error} />}
      {!detail && !current.error && <p className="muted">Loading…</p>}

      <Section title="TRIGGER">
        <p className={focusClass(focus?.kind === "trigger")} ref={focus?.kind === "trigger" ? setFocusEl : undefined}>
          <span>{triggerLabel(run.trigger)}</span>
          <span className="muted"> · {formatEventTime(Date.parse(run.startedAt))}</span>
          {trigger && (
            <button
              type="button"
              aria-label={`Open ${triggerLabel(run.trigger)}`}
              onClick={() => void openUrl(trigger).catch(() => undefined)}
            >
              Open
            </button>
          )}
        </p>
      </Section>

      <Section title="COST">
        <p title={`${exactUsd(run.costUsd)} of ${exactUsd(run.budgetUsd)}`}>
          {formatUsd(run.costUsd)} of {formatUsd(run.budgetUsd)}
        </p>
        <div
          className="budget"
          role="progressbar"
          aria-label="Budget used"
          aria-valuemin={0}
          aria-valuemax={run.budgetUsd > 0 ? run.budgetUsd : undefined}
          aria-valuenow={run.budgetUsd > 0 ? Math.min(run.costUsd, run.budgetUsd) : undefined}
        >
          <div style={{ width: `${pct}%` }} />
        </div>
        <p className="muted">
          {run.tokensIn.toLocaleString("en-US")} in · {run.tokensOut.toLocaleString("en-US")} out
        </p>
      </Section>

      {detail && detail.outcomes.length > 0 && (
        <Section title="LINKS">
          <ul className="panel-list">
            {detail.outcomes.map((o, i) => {
              const { label } = outcomeLabel(o);
              const url = outcomeLink(o);
              return (
                <li key={i} className={focusClass(focused(i))} ref={focused(i) ? setFocusEl : undefined}>
                  <span>{label}</span>
                  {o.at && <span className="muted"> · {formatEventTime(Date.parse(o.at))}</span>}
                  {url && (
                    <button
                      type="button"
                      aria-label={`Open ${label}`}
                      onClick={() => void openUrl(url).catch(() => undefined)}
                    >
                      Open
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {run.agentKind === "coding" ? (
        <Section title="ACTIVITY">
          <p>Last activity {relativeTime(run.heartbeatAt, now)}</p>
          {onOpenPod && (
            <button type="button" onClick={() => onOpenPod(run.id)}>
              Pod ↗
            </button>
          )}
        </Section>
      ) : (
        <Section title="TURNS">
          <p>
            Turn {run.turns} · last activity {relativeTime(run.heartbeatAt, now)}
          </p>
          {onOpenPod && run.nativeExecutionMode === "sandbox" && (
            <button type="button" onClick={() => onOpenPod(run.id)}>
              Pod ↗
            </button>
          )}
        </Section>
      )}

      {serviceNames.length > 0 && (
        <Section title="SERVICES">
          <ul className="panel-list">
            {serviceNames.map((name) => {
              const status = statuses.get(name);
              const snap = snapshots.get(name);
              return (
                <li key={name}>
                  <div>
                    <span>{snap ? `${name} ${snap.version}` : name}</span>{" "}
                    {status ? (
                      <span className={`chip ${status.state}`}>{serviceChip(status)}</span>
                    ) : live ? (
                      <span className="chip pending">○ pending</span>
                    ) : (
                      <span className="chip unrecorded" title="This run recorded no service status.">
                        status not recorded
                      </span>
                    )}
                  </div>
                  {snap && (
                    <>
                      <div className="muted" title={snap.image}>
                        image {shortImage(snap.image)}
                      </div>
                      {snap.envNames.length > 0 && (
                        <ul className="env-names" aria-label={`${name} environment variables`}>
                          {snap.envNames.map((n) => (
                            <li key={n}>
                              <code>{n}</code>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {detail && detail.childRunIds.length > 0 && (
        <Section title="CHILDREN">
          <ul className="panel-list">
            {detail.childRunIds.map((id) => (
              <li key={id}>
                <RunLink id={id} runs={runs} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {run.parentRunId && (
        <Section title="PARENT">
          <RunLink id={run.parentRunId} runs={runs} onSelect={onSelect} />
        </Section>
      )}

      {detail?.error && (
        <details open className="panel-section">
          <summary>ERROR</summary>
          <pre className="panel-pre">{detail.error}</pre>
        </details>
      )}
      {detail?.finalText && (
        <details className="panel-section">
          <summary>FINAL TEXT</summary>
          <pre className="panel-pre">{detail.finalText}</pre>
        </details>
      )}

      <footer className="panel-foot">
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard?.writeText(run.id).then(
              () => setCopied(true),
              () => undefined,
            )
          }
        >
          Copy id
        </button>
        {copied && <span role="status"> Copied</span>}
      </footer>
    </aside>
  );
}
