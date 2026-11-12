import type { ServerSummary } from "../api/client";
import type { ViewerModel } from "../state/reducer";
import { ServerMenu } from "./ServerMenu";
import { formatSpanTime } from "../format/time";
import { plural } from "../format/text";
import { formatWindowTotal, TRUNCATED_TITLE } from "../format/spend";
import { STATUS_GROUPS, WINDOWS, type Filters, type StatusGroup, type WindowSize } from "../state/filters";
import { exactUsd, formatUsd } from "../format/money";

export type Tab = "runs" | "infra" | "documents";

/** Cluster line and view controls shown on the Infrastructure tab. */
export interface InfraBar {
  mode: "map" | "table";
  onModeChange: (m: "map" | "table") => void;
  context: string | null;
  contexts: string[];
  onContextChange: (c: string) => void;
  platformLabel: string;
  namespace: string | null;
  watching: boolean;
}

const TAB_LABEL: Record<Tab, string> = { runs: "Runs", infra: "Infrastructure", documents: "Documents" };

const GROUP_LABEL: Record<StatusGroup, string> = {
  running: "running",
  failed: "failed",
  succeeded: "succeeded",
  pending: "pending",
};

interface Props {
  servers: ServerSummary[];
  selectedUrl: string | null;
  onSelectServer: (url: string) => void;
  onAddServer: () => void;
  onSignOut: () => void;
  onRemoveServer: () => void;
  live: boolean;
  reconnecting: boolean;
  filters: Filters;
  onFiltersChange: (f: Filters) => void;
  agents: { id: string; name: string }[];
  spend: ViewerModel["spend"];
  /** Sum of costUsd over the runs in the current snapshot (the selected window). */
  windowSpendUsd: number;
  /** The snapshot hit its row limit, so the window total is a lower bound. */
  windowSpendTruncated?: boolean;
  /** Runs (matching the other filters) that fall inside the brushed range. */
  rangeRunCount: number;
  onClearRange: () => void;
  tab?: Tab;
  onTabChange?: (t: Tab) => void;
  infra?: InfraBar;
}

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

/** Today's spend against the smallest daily group cap, when any group has one. */
export function spendSummary(spend: ViewerModel["spend"]): { spent: number; cap: number | null } | null {
  if (!spend) return null;
  const caps = spend.groups.map((g) => g.dailyBudgetUsd).filter((c): c is number => c !== null && c > 0);
  return { spent: spend.todayUsd, cap: caps.length > 0 ? Math.min(...caps) : null };
}

export function TopBar(props: Props) {
  const { servers, selectedUrl, filters, onFiltersChange } = props;
  const spend = spendSummary(props.spend);
  const set = (patch: Partial<Filters>) => onFiltersChange({ ...filters, ...patch });
  const tab = props.tab ?? "runs";
  const infra = tab === "infra" ? props.infra : undefined;
  const badge = props.live ? "● live" : props.reconnecting ? "◌ reconnecting" : "○ offline";

  return (
    <header className="topbar">
      <div className="topbar-row">
        <span className="brand">wardby</span>
        <div className="tabs" role="group" aria-label="View">
          {(["runs", "infra", "documents"] as const).map((t) => (
            <button key={t} type="button" aria-pressed={tab === t} onClick={() => props.onTabChange?.(t)}>
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        <label className="inline">
          <span className="sr-only">Server</span>
          <select
            aria-label="Server"
            value={selectedUrl ?? ""}
            onChange={(e) => {
              if (e.target.value === "__add") props.onAddServer();
              else props.onSelectServer(e.target.value);
            }}
          >
            {servers.map((s) => (
              <option key={s.url} value={s.url}>
                {s.name}
              </option>
            ))}
            <option value="__add">Add server…</option>
          </select>
        </label>
        <ServerMenu signedIn onSignOut={props.onSignOut} onRemove={props.onRemoveServer} />
        <span
          className={`badge ${props.live ? "live" : props.reconnecting ? "reconnecting" : "offline"}`}
          role="status"
        >
          {badge}
        </span>
      </div>
      {tab === "documents" ? null : tab === "infra" ? (
        infra && (
          <div className="topbar-row infra-row">
            <div className="tabs" role="group" aria-label="Infrastructure view">
              {(["map", "table"] as const).map((m) => (
                <button key={m} type="button" aria-pressed={infra.mode === m} onClick={() => infra.onModeChange(m)}>
                  {m === "map" ? "Map" : "Table"}
                </button>
              ))}
            </div>
            <span className="muted infra-status">
              {infra.platformLabel} · ns {infra.namespace ?? "–"} ·{" "}
              <span className={`badge ${infra.watching ? "live" : "offline"}`}>
                {infra.watching ? "● watching" : "○ disconnected"}
              </span>
            </span>
            <label className="inline kube-context">
              <span className="sr-only">Kube context</span>
              <select
                aria-label="Kube context"
                title={infra.context ?? undefined}
                value={infra.context ?? ""}
                onChange={(e) => infra.onContextChange(e.target.value)}
              >
                {!infra.context && (
                  <option value="" disabled>
                    Choose a context…
                  </option>
                )}
                {infra.context && !infra.contexts.includes(infra.context) && (
                  <option value={infra.context}>{infra.context}</option>
                )}
                {infra.contexts.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )
      ) : (
        <div className="topbar-row">
          <label className="inline">
            <span className="sr-only">Time window</span>
            <select
              aria-label="Time window"
              value={filters.window}
              onChange={(e) => set({ window: e.target.value as WindowSize })}
            >
              {WINDOWS.map((w) => (
                <option key={w} value={w}>
                  Last {w}
                </option>
              ))}
            </select>
          </label>
          <details className="agent-filter">
            <summary>{filters.agents.size === 0 ? "Agents: all" : `Agents: ${filters.agents.size}`}</summary>
            <div className="popover">
              {props.agents.length === 0 && <span className="muted">No agents in window</span>}
              {props.agents.map((a) => (
                <label key={a.id} className="check">
                  <input
                    type="checkbox"
                    checked={filters.agents.has(a.id)}
                    onChange={() => set({ agents: toggled(filters.agents, a.id) })}
                  />
                  {a.name}
                </label>
              ))}
            </div>
          </details>
          <fieldset className="statuses">
            <legend className="sr-only">Status</legend>
            {STATUS_GROUPS.map((g) => (
              <label key={g} className="check">
                <input
                  type="checkbox"
                  checked={filters.statuses.has(g)}
                  onChange={() => set({ statuses: toggled(filters.statuses, g) })}
                />
                {GROUP_LABEL[g]}
              </label>
            ))}
          </fieldset>
          <input
            type="search"
            aria-label="Search runs"
            placeholder="search…"
            value={filters.search}
            onChange={(e) => set({ search: e.target.value })}
          />
          {filters.timeRange && (
            <div className="range-chip">
              <span>
                {formatSpanTime(filters.window, filters.timeRange.from)} →{" "}
                {formatSpanTime(filters.window, filters.timeRange.to)} · {plural(props.rangeRunCount, "run")}
              </span>
              <button type="button" aria-label="Clear time range" title="Clear time range" onClick={props.onClearRange}>
                ✕
              </button>
            </div>
          )}
          {spend && (
            <div className="spend" aria-label="Today's spend">
              <span
                title={
                  props.windowSpendTruncated
                    ? `${exactUsd(props.windowSpendUsd)}\n${TRUNCATED_TITLE}`
                    : exactUsd(props.windowSpendUsd)
                }
              >
                {filters.window} {formatWindowTotal(props.windowSpendUsd, props.windowSpendTruncated ?? false)} ·{" "}
              </span>
              <span title={`${exactUsd(spend.spent)}${spend.cap !== null ? ` / ${exactUsd(spend.cap)}` : ""}`}>
                Today {formatUsd(spend.spent)}
                {spend.cap !== null && ` / ${formatUsd(spend.cap)}`}
              </span>
              {spend.cap !== null && (
                <div
                  className="meter"
                  role="meter"
                  aria-label="Spend against daily cap"
                  aria-valuemin={0}
                  aria-valuemax={spend.cap}
                  aria-valuenow={Math.min(spend.spent, spend.cap)}
                >
                  <div style={{ width: `${Math.min(100, (spend.spent / spend.cap) * 100)}%` }} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
