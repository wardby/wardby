import { atom, read, update } from "claude-code";
import type { Register, UiCopyArgs } from "claude-code";

import type { Filter, OpenStep, Poll, Resume, RunDetail, RunRow, Step, Steps } from "../types";

const PANE = "wardby-runs";
const ACTIVE = new Set(["pending", "running"]);
// How many runs to ask each agent for, and how far back a finished run stays listed.
const PER_AGENT = 5;
const RECENT_MS = 24 * 60 * 60 * 1000;
// The agent list (names, budgets) changes rarely: refresh it every this many polls.
const AGENTS_EVERY = 6;
// Run steps (wardby 0.9.0+): a running run's last RECENT_STEPS, re-read each poll; a finished run's, a page at a time.
const RECENT_STEPS = 8;
const STEPS_PAGE = 200;
// What a server without get_run_steps answers (the MCP SDK's "Tool <name> not found").
const UNKNOWN_TOOL = /\btool\b[^\n]*\bnot found\b|unknown tool|no such tool/i;
// The timer ticks this often; each tick refreshes only when one is due.
const TICK_MS = 5000;
// An incremental refresh asks for changes since the last one, less this overlap for clock skew;
// every FULL_EVERY refreshes asks for the whole day again to correct any drift.
const OVERLAP_MS = 30_000;
const FULL_EVERY = 30;
// The longest a failing server waits between tries.
const MAX_BACKOFF_MS = 5 * 60 * 1000;

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const runs = atom({ plugin: "wardby-runs", key: "runs" } as const, [], { shape: "runs-4" });

// How each Run.trigger value reads in the pane.
const TRIGGER_LABELS: Record<string, string> = {
  manual: "manual",
  scheduled: "schedule",
  webhook: "webhook",
  subagent: "sub-agent",
  host_event: "GitHub/Jira event",
};
const triggerLabel = (trigger: string): string => TRIGGER_LABELS[trigger] ?? trigger;

// A task naming a GitHub pull request or issue ("Review pull request #12 in org/repo"), as its URL.
const TASK_REF = /\b(pull request|PR|issue) #(\d+) in ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i;

/** The GitHub URL a task names, or null when it names none. */
function taskUrl(task: string | null): string | null {
  const match = task ? TASK_REF.exec(task) : null;
  if (!match) return null;
  const kind = /issue/i.test(match[1]) ? "issues" : "pull";
  return `https://github.com/${match[3]}/${kind}/${match[2]}`;
}
const selected = atom({ plugin: "wardby-runs", key: "selected" } as const, null);
const detail = atom({ plugin: "wardby-runs", key: "detail" } as const, null, { shape: "detail-3" });
// A run's steps as get_run_steps returned them (stored already redacted); drawn as plain text only.
const runSteps = atom({ plugin: "wardby-runs", key: "steps" } as const, null, { shape: "steps-2" });
// The step whose detail is shown (one at a time), and the terminal's cursor among steps with detail.
const openStep = atom({ plugin: "wardby-runs", key: "openStep" } as const, null, { shape: "open-step-1" });
const poll = atom({ plugin: "wardby-runs", key: "poll" } as const, { at: 0, error: null }, { shape: "poll-1" });
// Continue locally: the folder to import into, and how the last import went. Never the download link.
const resume = atom({ plugin: "wardby-runs", key: "resume" } as const, null, { shape: "resume-1" });
// The run whose long fields (request, task, final text) are shown in full, not cut to a line.
const expanded = atom({ plugin: "wardby-runs", key: "expanded" } as const, null);
// The ledger's groups the person opened or folded, by group key (a pull request, or "other").
const groupOpen = atom({ plugin: "wardby-runs", key: "groupOpen" } as const, {}, { shape: "group-open-1" });
// The desktop's list view, and the step each strip card shows (by group key).
const view = atom({ plugin: "wardby-runs", key: "view" } as const, "ledger");
const picked = atom({ plugin: "wardby-runs", key: "picked" } as const, {}, { shape: "picked-1" });
const filter = atom(
  { plugin: "wardby-runs", key: "filter" } as const,
  { status: "all", text: "" },
  { shape: "filter-1" },
);

// The status filter's choices: label, hotkey, and which statuses each keeps.
const STATUS_FILTERS: { value: Filter["status"]; label: string; hotkey: string; keeps: (status: string) => boolean }[] =
  [
    { value: "all", label: "All", hotkey: "a", keeps: () => true },
    { value: "active", label: "Active", hotkey: "t", keeps: (status) => ACTIVE.has(status) },
    { value: "failed", label: "Failed", hotkey: "f", keeps: (status) => !ACTIVE.has(status) && status !== "succeeded" },
    { value: "done", label: "Done", hotkey: "d", keeps: (status) => status === "succeeded" },
  ];

/** The rows a filter keeps: its status choice, and text found in the agent's name, the status or the trigger. */
/**
 * The rows as run trees, built from the parentRunId each row carries: every lead run (or a run whose
 * lead isn't listed), newest first, each followed by its sub-agent runs in the order they started,
 * with their depth. Only runs the pane already lists appear; a child the caller can't see is absent.
 */
function asTrees(rows: RunRow[]): { row: RunRow; depth: number }[] {
  const ids = new Set(rows.map((row) => row.id));
  const children = new Map<string, RunRow[]>();
  for (const row of rows) {
    if (row.parentRunId && ids.has(row.parentRunId)) {
      children.set(row.parentRunId, [...(children.get(row.parentRunId) ?? []), row]);
    }
  }
  const out: { row: RunRow; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (row: RunRow, depth: number) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    out.push({ row, depth });
    const kids = [...(children.get(row.id) ?? [])].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    for (const kid of kids) walk(kid, depth + 1);
  };
  for (const row of rows) if (!row.parentRunId || !ids.has(row.parentRunId)) walk(row, 0);
  return out;
}

/** The listed tree a run belongs to: its topmost listed lead and everything under it. */
function treeOf(rows: RunRow[], runId: string): { row: RunRow; depth: number }[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  let top = byId.get(runId);
  while (top?.parentRunId && byId.has(top.parentRunId)) top = byId.get(top.parentRunId);
  if (!top) return [];
  const trees = asTrees(rows);
  const start = trees.findIndex((entry) => entry.row.id === top!.id);
  const end = trees.findIndex((entry, i) => i > start && entry.depth === 0);
  return trees.slice(start, end === -1 ? undefined : end);
}

/** One line of the list: a pull request heading, or a run at a depth with the event that started it. */
type ListEntry =
  | { kind: "heading"; pr: string; url: string | null }
  | { kind: "run"; row: RunRow; depth: number; event: string | null };

/**
 * The run trees grouped into pull-request chains, as the admin viewer draws them: every tree whose lead
 * was started by a pull request, or opened one, sits under that pull request, newest first, the event
 * that started it (review, mention) beside it. Trees that touch no pull request stand alone.
 * Newest chain or tree first. Without triggerInfo and outcomes (an older server) every tree stands alone.
 */
function asChains(rows: RunRow[]): ListEntry[] {
  const trees: { row: RunRow; depth: number }[][] = [];
  for (const entry of asTrees(rows)) {
    if (entry.depth === 0) trees.push([entry]);
    else trees[trees.length - 1]?.push(entry);
  }
  const keyOf = (tree: { row: RunRow }[]): { pr: string; url: string | null } | null => {
    const lead = tree[0].row;
    if (lead.via) return { pr: lead.via.pr, url: lead.via.url };
    for (const { row } of tree) {
      const opened = row.outcomes.find((o) => o.kind === "pull_request" && o.pr);
      if (opened?.pr) return { pr: opened.pr, url: opened.url };
    }
    return null;
  };
  type Unit = {
    key: { pr: string; url: string | null } | null;
    trees: { row: RunRow; depth: number }[][];
    newest: number;
  };
  const units = new Map<string, Unit>();
  const alone: Unit[] = [];
  for (const tree of trees) {
    const key = keyOf(tree);
    const newest = Math.max(...tree.map(({ row }) => Date.parse(row.startedAt)));
    if (!key) {
      alone.push({ key: null, trees: [tree], newest });
      continue;
    }
    const unit = units.get(key.pr) ?? { key, trees: [], newest: 0 };
    unit.trees.push(tree);
    unit.newest = Math.max(unit.newest, newest);
    if (!unit.key?.url && key.url) unit.key = key;
    units.set(key.pr, unit);
  }
  const ordered = [...units.values(), ...alone].sort((a, b) => b.newest - a.newest);
  return ordered.flatMap((unit) => {
    // A pull request touched by one tree only reads fine without a heading.
    if (!unit.key || unit.trees.length < 2) {
      return unit.trees.flat().map(({ row, depth }) => ({ kind: "run" as const, row, depth, event: null }));
    }
    const heading: ListEntry = { kind: "heading", pr: unit.key.pr, url: unit.key.url };
    const sorted = [...unit.trees].sort((a, b) => Date.parse(b[0].row.startedAt) - Date.parse(a[0].row.startedAt));
    return [
      heading,
      ...sorted.flat().map(({ row, depth }) => ({
        kind: "run" as const,
        row,
        depth: depth + 1,
        event: depth === 0 ? (row.via?.event ?? triggerLabel(row.trigger)) : null,
      })),
    ];
  });
}

/** One group of the desktop ledger: a pull request (or issue) and its runs, or the runs that touch none. */
type LedgerGroup = {
  key: string;
  label: string;
  url: string | null;
  rows: { row: RunRow; depth: number; event: string | null }[];
};

/** The short name of the event behind a step: opened, review, fix 1, or the trigger. */
function stepLabel(row: RunRow, event: string | null): string {
  if (event === "review") return "review";
  if (event === "mention") {
    const round = /fix round (\d+) of \d+/i.exec(row.task ?? "");
    return round ? `fix ${round[1]}` : "follow-up";
  }
  if (row.outcomes.some((o) => o.kind === "pull_request") && !row.parentRunId) return "opened";
  return "";
}

/**
 * The runs as ledger groups: every tree that a pull request started or that opened one sits in that
 * pull request's group, with its sub-agent runs under their lead; the rest go to "other". Groups,
 * "other" too, are ordered by their newest run, newest first. Within a group the trees are newest first
 * for the ledger, or oldest first ("oldest") for a strip, which reads left to right.
 */
function asLedger(rows: RunRow[], order: "newest" | "oldest" = "newest"): LedgerGroup[] {
  const groups = new Map<string, LedgerGroup & { newest: number; trees: { row: RunRow; depth: number }[][] }>();
  const trees: { row: RunRow; depth: number }[][] = [];
  for (const entry of asTrees(rows)) {
    if (entry.depth === 0) trees.push([entry]);
    else trees[trees.length - 1]?.push(entry);
  }
  for (const tree of trees) {
    const lead = tree[0].row;
    const opened = tree.flatMap(({ row }) => row.outcomes).find((o) => o.kind === "pull_request" && o.pr);
    const ref = lead.via ?? (opened?.pr ? { pr: opened.pr, url: opened.url, event: "" } : null);
    const key = ref?.pr ?? "other";
    const label = !ref
      ? "Other"
      : ref.pr.startsWith("issue:")
        ? ref.pr.slice("issue:".length)
        : ref.pr.replace(/^[^/]+\//, "");
    const group = groups.get(key) ?? { key, label, url: ref?.url ?? null, rows: [], newest: 0, trees: [] };
    if (!group.url && ref?.url) group.url = ref.url;
    group.trees.push(tree);
    group.newest = Math.max(group.newest, ...tree.map(({ row }) => Date.parse(row.startedAt)));
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.newest - a.newest)
    .map((group) => ({
      key: group.key,
      label: group.label,
      url: group.url,
      rows: [...group.trees]
        .sort(
          (a, b) => (order === "newest" ? -1 : 1) * (Date.parse(a[0].row.startedAt) - Date.parse(b[0].row.startedAt)),
        )
        .flat()
        .map(({ row, depth }) => ({ row, depth, event: depth === 0 ? (row.via?.event ?? null) : null })),
    }));
}

/** A step's name in full, for a strip card's detail: "Opened PR #160", "Review", "Fix round 2 of 2". */
function stepName(row: RunRow, event: string | null): string {
  if (event === "review") return "Review";
  if (event === "mention") {
    const round = /fix round (\d+) of (\d+)/i.exec(row.task ?? "");
    return round ? `Fix round ${round[1]} of ${round[2]}` : "Follow-up";
  }
  const opened = row.outcomes.find((o) => o.kind === "pull_request");
  if (opened && !row.parentRunId) return opened.text.replace(/^opened/, "Opened");
  return taskLine(row.task) ?? row.agentName;
}

/** The most steps a strip draws; earlier ones are counted and the ledger shows them all. */
const STRIP_MAX = 6;
// A strip step's column, in cells, and its drawing, in pixels: drawn a little wider than the column
// so the lines from neighbouring steps meet whatever a cell measures, then clipped to the column.
const STRIP_CELLS = 10;
const STRIP_PX = 120;

/**
 * One step of a strip as SVG: its status mark centred, a line in from the left (green when the step
 * before it succeeded) and a line out to the right (green when this step succeeded), none at the
 * strip's ends; the shown step is ringed.
 */
function stepSvg(
  status: string,
  opts: { isFirst: boolean; isLast: boolean; isPicked: boolean; intoDone: boolean },
): string {
  const mid = STRIP_PX / 2;
  const parts: string[] = [];
  if (!opts.isFirst)
    parts.push(
      `<rect x="0" y="10" width="${mid - 9}" height="2" fill="${opts.intoDone ? SVG_STATUS.succeeded : SVG_TRACK}" />`,
    );
  if (!opts.isLast)
    parts.push(
      `<rect x="${mid + 9}" y="10" width="${mid - 9}" height="2" fill="${status === "succeeded" ? SVG_STATUS.succeeded : SVG_TRACK}" />`,
    );
  if (opts.isPicked)
    parts.push(`<circle cx="${mid}" cy="11" r="10" fill="none" stroke="${SVG_STATUS.running}" stroke-width="2" />`);
  const color = svgStatus(status);
  parts.push(
    status === "pending"
      ? `<circle cx="${mid}" cy="11" r="7" fill="none" stroke="${color}" stroke-width="1.5" />`
      : `<circle cx="${mid}" cy="11" r="7" fill="${color}" />`,
  );
  const glyph = status === "succeeded" ? "✓" : status === "running" || status === "pending" ? "" : "✕";
  if (glyph)
    parts.push(
      `<text x="${mid}" y="14.5" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" font-family="system-ui,sans-serif">${glyph}</text>`,
    );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${STRIP_PX}" height="22" viewBox="0 0 ${STRIP_PX} 22">${parts.join("")}</svg>`;
}

/** A group's state in a few words: what its newest active run is doing, else how it ended. */
function groupState(group: LedgerGroup): string {
  const count = `${group.rows.length} ${group.rows.length === 1 ? "run" : "runs"}`;
  // The newest active lead run says what is happening; a sub-agent run only says "running".
  const leads = [...group.rows].reverse();
  const active =
    leads.find(({ row, depth }) => depth === 0 && ACTIVE.has(row.status)) ??
    leads.find(({ row }) => ACTIVE.has(row.status));
  if (active) {
    const label = stepLabel(active.row, active.event);
    return `${count}, ${label.startsWith("fix") ? "fixing" : label === "review" ? "in review" : "running"}`;
  }
  const last = group.rows.filter(({ depth }) => depth === 0).pop()?.row;
  return `${count}, ${last && last.status !== "succeeded" ? last.status.replaceAll("_", " ") : "done"}`;
}

/** A group's state as a colour, for the bar at its row's left edge: running, failed or done. */
function groupColor(group: LedgerGroup): string {
  if (group.rows.some(({ row }) => ACTIVE.has(row.status))) return STATUS_COLOR.running;
  const last = group.rows.filter(({ depth }) => depth === 0).pop()?.row;
  return last && last.status !== "succeeded" ? FAILED_COLOR : STATUS_COLOR.succeeded;
}

/** The drawing of a depth: nothing at the top, then an indent and a branch mark. */
const branch = (depth: number): string => (depth === 0 ? "" : `${"   ".repeat(depth)}└ `);

function filtered(rows: RunRow[], f: Filter): RunRow[] {
  const keeps = STATUS_FILTERS.find((choice) => choice.value === f.status)?.keeps ?? (() => true);
  const text = f.text.trim().toLowerCase();
  return rows.filter(
    (row) =>
      keeps(row.status) &&
      (text === "" ||
        [row.agentName, row.status, row.trigger, triggerLabel(row.trigger), row.task ?? ""].some((field) =>
          field.toLowerCase().includes(text),
        )),
  );
}

type Agent = { id: string; name: string; budgetUsd: number | null };
type Call = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/** The first text block of an MCP result, parsed as JSON; an error result throws its text. */
function parseResult(tool: string, result: { content: { type: string; text?: string }[]; isError: boolean }): unknown {
  const text = result.content.find((block) => block.type === "text")?.text ?? "";
  if (result.isError) throw new Error(`${tool}: ${text.slice(0, 200) || "the wardby server reported an error"}`);
  try {
    return JSON.parse(text);
  } catch {
    // An error the server or client sent back as plain text: show it, not the parse failure.
    throw new Error(`${tool}: ${text.slice(0, 200) || "empty reply"}`);
  }
}

const num = (value: unknown): number => (value == null ? 0 : Number(value));
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** A pull request's key and page: `owner/repo#12`, and its GitHub URL when the host is GitHub. */
function prRef(value: Record<string, unknown>): { pr: string; url: string | null } | null {
  const repository = str(value.repository);
  const number = typeof value.number === "number" ? value.number : null;
  if (!repository || number === null) return null;
  const url =
    str(value.url) ?? (value.provider === "github" ? `https://github.com/${repository}/pull/${number}` : null);
  return { pr: `${repository}#${number}`, url };
}

/** What started a run, from the server's triggerInfo (wardby 0.8.0+): the pull request and the event. */
function toVia(info: unknown): RunRow["via"] {
  if (typeof info !== "object" || info === null) return null;
  const trigger = info as Record<string, unknown>;
  if (trigger.kind === "code_host") {
    const ref = prRef(trigger);
    return ref ? { ...ref, event: str(trigger.event) ?? "event" } : null;
  }
  if (trigger.kind === "issue") {
    const key = str(trigger.issueKey);
    return key ? { pr: `issue:${key}`, url: str(trigger.url), event: "issue" } : null;
  }
  return null;
}

/** What a run produced, from the server's outcomes (wardby 0.8.0+), as short labelled links. */
function toOutcomes(value: unknown): RunRow["outcomes"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const outcome = item as Record<string, unknown>;
    const ref = prRef(outcome);
    switch (outcome.kind) {
      case "pull_request":
        return ref
          ? [{ kind: "pull_request", text: `opened PR #${String(outcome.number)}`, url: ref.url, pr: ref.pr }]
          : [];
      case "code_host_comment":
        return [{ kind: "comment", text: "commented", url: ref?.url ?? null, pr: ref?.pr ?? null }];
      case "check":
        return [
          {
            kind: "check",
            text: outcome.completed ? "check completed" : "check pending",
            url: ref?.url ?? null,
            pr: ref?.pr ?? null,
          },
        ];
      case "issue_comment":
        return [
          { kind: "issue_comment", text: `commented on ${String(outcome.issueKey)}`, url: str(outcome.url), pr: null },
        ];
      default:
        return [];
    }
  });
}

/** The line the server wrote for a run's newest step (lastStep.line, wardby 0.9.0+); null without one. */
function lastLineOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  return str((value as Record<string, unknown>).line);
}

/** A row's last step is shown on running and failed rows only (where it is or where it went wrong). */
const showsLastLine = (row: RunRow): boolean =>
  row.lastLine != null && (row.status === "running" || row.status === "failed");

function toRow(run: Record<string, unknown>, agent: Agent): RunRow {
  return {
    id: String(run.id),
    agentId: agent.id,
    agentName: agent.name,
    status: String(run.status),
    trigger: String(run.trigger ?? ""),
    costUsd: num(run.costUsd),
    budgetUsd: agent.budgetUsd,
    startedAt: String(run.startedAt),
    finishedAt: str(run.finishedAt),
    heartbeatAt: str(run.heartbeatAt),
    turns: num(run.turns),
    // The task the trigger or lead gave the run (for example "Review pull request #12 in org/repo").
    task: str(run.taskOverride),
    parentRunId: str(run.parentRunId),
    via: toVia(run.triggerInfo),
    outcomes: toOutcomes(run.outcomes),
    lastLine: lastLineOf(run.lastStep),
  };
}

function toDetail(run: Record<string, unknown>): RunDetail {
  const coding = (run.codingResult ?? {}) as Record<string, unknown>;
  const lastStep = (run.lastStep ?? {}) as Record<string, unknown>;
  const pricing = (run.pricingSnapshot ?? {}) as Record<string, unknown>;
  // Each service's start-up state (serviceReadiness, wardby 0.8.0+), by name; none from an older server.
  const readiness = Array.isArray(run.serviceReadiness) ? (run.serviceReadiness as unknown[]) : [];
  const serviceStates: Record<string, string> = {};
  for (const item of readiness) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const name = str(entry.name);
    const state = str(entry.state);
    if (name && state) serviceStates[name] = state;
  }
  return {
    id: String(run.id),
    request: str(run.request),
    finalText: str(run.finalText),
    error: str(run.error),
    failureCategory: str(run.failureCategory),
    outcome: str(coding.outcome),
    repository: str(coding.repository),
    pullRequestUrl: str(coding.pullRequestUrl),
    resultBranch: str(run.resultBranch),
    services: Array.isArray(run.services) ? run.services.map(String) : [],
    serviceStates,
    // The model the run was billed at (its catalog entry), when the server recorded one.
    model: str(pricing.modelId),
    parentRunId: str(run.parentRunId),
    lastStepSeq: typeof lastStep.seq === "number" ? lastStep.seq : null,
  };
}

/** get_run_steps' steps, keeping only well-formed ones. */
function toSteps(value: unknown): Step[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const s = item as Record<string, unknown>;
    if (typeof s.seq !== "number" || typeof s.summary !== "string") return [];
    return [
      {
        seq: s.seq,
        at: String(s.at ?? ""),
        kind: String(s.kind ?? ""),
        tool: str(s.tool),
        summary: plainText(s.summary),
        status: str(s.status),
        // An empty detail is no detail: nothing to expand.
        detail: typeof s.detail === "string" && plainText(s.detail) !== "" ? plainText(s.detail) : null,
      },
    ];
  });
}

/* eslint-disable no-control-regex -- matching control characters is the point */
// A copy of src/core/run-steps/control-chars.ts (the plugin cannot import src/): servers strip step
// text before storing it, but rows stored by an older server can still hold escape sequences.
const STRING_SEQUENCE = /(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g;
const CSI_SEQUENCE = /(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */

/** Step text without terminal control sequences or control characters other than \n and \t. */
function plainText(text: string): string {
  return text.replace(STRING_SEQUENCE, "").replace(CSI_SEQUENCE, "").replace(/\r\n/g, "\n").replace(CONTROL, "");
}

/** The most lines of a step's detail the pane shows: its end, as a detail ends in the output's end. */
const DETAIL_LINES = 40;

/** The last DETAIL_LINES lines of `detail`, and how many lines before them are not shown. */
function detailTail(detail: string): { text: string; hidden: number } {
  const lines = detail.split("\n");
  const hidden = Math.max(0, lines.length - DETAIL_LINES);
  return { text: lines.slice(hidden).join("\n"), hidden };
}

/** The cursor moved by `delta` among `seqs` (from the first or last when there is none). */
function moveCursor(current: OpenStep | null, runId: string, seqs: number[], delta: 1 | -1): OpenStep | null {
  if (seqs.length === 0) return current;
  const at = current?.runId === runId ? seqs.indexOf(current.seq) : -1;
  const next = at < 0 ? (delta > 0 ? 0 : seqs.length - 1) : Math.min(seqs.length - 1, Math.max(0, at + delta));
  // An expanded step stays expanded as the cursor moves: the detail follows the cursor.
  return { runId, seq: seqs[next], open: current?.runId === runId && current.open };
}

/** A tool step's text for the terminal's one-line row: "Bash: npm test"; what the model said for the rest. */
function stepText(step: Step): string {
  return step.kind === "tool" ? `${step.tool ?? "tool"}: ${step.summary}` : step.summary;
}

/** A tool step's result in its row's gutter: ✓ for ok, the exit code, ! for an error, … while it runs. */
function stepMark(step: Step): { mark: string; failed: boolean } | null {
  if (step.kind !== "tool") return null;
  if (step.status === null) return { mark: "…", failed: false };
  if (step.status === "ok") return { mark: "✓", failed: false };
  const code = /^exit (\d+)$/.exec(step.status)?.[1];
  return { mark: code ?? "!", failed: true };
}

/** The first DETAIL_LINES lines of `text`, and how many lines after them are not shown (what a model said reads from its start). */
function detailHead(text: string): { text: string; hidden: number } {
  const lines = text.split("\n");
  const hidden = Math.max(0, lines.length - DETAIL_LINES);
  return { text: lines.slice(0, DETAIL_LINES).join("\n"), hidden };
}

// The detail's input and output halves (src/core/run-steps/types.ts DETAIL_OUTPUT_HEADING); a JSON input
// has no raw newline, so the first match is the heading.
const OUTPUT_HEADING = /\n--- output \(end\) ---(?:\n|$)/;
// Codex's framing at the head of a command's output: dropped for display, the exit code kept.
const CODEX_FRAME = /^(?:Chunk ID: .*|Wall time: .*|Original token count: .*)$/;
const CODEX_EXIT = /^Process exited with code (-?\d{1,6})$/;
const SHELL = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh$/;

/** A command input as one line: a string, or an argv (a shell's -c / -lc script read as its script). */
function commandOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!Array.isArray(value) || value.length === 0 || !value.every((part) => typeof part === "string")) return null;
  const argv = value as string[];
  if (argv.length === 3 && SHELL.test(argv[0]) && (argv[1] === "-c" || argv[1] === "-lc"))
    return argv[2].trim() || null;
  return argv.join(" ");
}

/**
 * A step's stored detail as the open step shows it: the command (the input JSON's `cmd` or `command`),
 * the exit code when the output says it, and the output without Codex's framing lines. Display only:
 * Copy copies the stored detail unchanged. Null when the input is not a command, to show the detail as is.
 */
function detailParts(detail: string): { command: string; exit: string | null; output: string } | null {
  const heading = OUTPUT_HEADING.exec(detail);
  const input = (heading ? detail.slice(0, heading.index) : detail).trim();
  let command: string | null = null;
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const fields = parsed as Record<string, unknown>;
      command = commandOf(fields.cmd) ?? commandOf(fields.command);
    }
  } catch {
    return null;
  }
  if (command === null) return null;
  const lines = heading ? detail.slice(heading.index + heading[0].length).split("\n") : [];
  let exit: string | null = null;
  // Only the framing at the head goes: once "Output:" is passed, or a line is not framing, the rest is output.
  let at = 0;
  for (; at < lines.length; at++) {
    const code = CODEX_EXIT.exec(lines[at])?.[1];
    if (code !== undefined) exit = code;
    else if (lines[at] === "Output:") {
      at++;
      break;
    } else if (!CODEX_FRAME.test(lines[at])) break;
  }
  return { command, exit, output: lines.slice(at).join("\n").replace(/\n+$/, "") };
}

/** Runs that are active, or finished within RECENT_MS, newest first. */
function visible(rows: RunRow[], now: number): RunRow[] {
  return rows
    .filter((row) => ACTIVE.has(row.status) || now - Date.parse(row.finishedAt ?? row.startedAt) < RECENT_MS)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "-";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function took(row: RunRow, now: number): string {
  const end = row.finishedAt ? Date.parse(row.finishedAt) : now;
  return ago(row.startedAt, end);
}

const usd = (value: number): string => `$${value.toFixed(2)}`;

// The desktop palette: colour carries a run's status, and nothing else is coloured.
// Text colours are the theme's own names, so they follow light and dark mode.
const STATUS_COLOR: Record<string, string> = { running: "suggestion", succeeded: "success", pending: "inactive" };
const FAILED_COLOR = "error";
const WARN_COLOR = "warning";
// SVG can't take theme names: mid-tone colours that read on light and dark, and a see-through grey track.
const SVG_STATUS: Record<string, string> = { running: "#3b82f6", succeeded: "#22c55e", pending: "#a8a29e" };
const SVG_FAILED = "#ef4444";
const SVG_WARN = "#f59e0b";
const SVG_TRACK = "#8884";
const svgStatus = (status: string): string => SVG_STATUS[status] ?? SVG_FAILED;
// Each ledger group sits in a soft box: a light rounded border and a little room inside.
// The theme's prompt-box border: visible in light and dark, where a dim border all but disappears.
const BORDER_COLOR = "promptBorder";
const GROUP_BOX = { borderStyle: "round", borderColor: BORDER_COLOR, paddingX: 1 } as const;

// Pills: a word on a soft tint of its colour. The word takes a theme name, so it follows light and dark
// mode; the tint is the same hue at 16% opacity, so it reads as a pale wash on a light panel and a deep
// one on a dark panel, never a fixed light fill. Only the desktop paints the tint; the terminal draws the
// word in its colour alone.
type Tone = "blue" | "green" | "red" | "amber" | "grey";
const TONES: Record<Tone, { fg: string; bg: string }> = {
  blue: { fg: "suggestion", bg: "#3b82f629" },
  green: { fg: "success", bg: "#22c55e29" },
  red: { fg: "error", bg: "#ef444429" },
  amber: { fg: "warning", bg: "#f59e0b29" },
  grey: { fg: "inactive", bg: "#a8a29e29" },
};
// The current run's row in a run tree: a faint wash, the same on light and dark.
const HIGHLIGHT_BG = "#a8a29e1f";
// The wardby.com palette, for the detail cards' colour bars (one colour per kind of section) and the
// desktop's step gutter. The mod cannot tell light from dark mode, so navy is a mid-tone that reads on both.
const WARDBY = {
  sky: "#75d4ff",
  mint: "#15b982",
  navy: "#3d6aa3",
  gold: "#c9aa70",
  slate: "#657287",
  red: "#e33d37",
} as const;
/** Each detail card's colour, by kind of section. */
const CARD_COLOR = {
  started: WARDBY.sky,
  produced: WARDBY.mint,
  tree: WARDBY.navy,
  final: WARDBY.navy,
  services: WARDBY.gold,
  steps: WARDBY.slate,
  error: WARDBY.red,
  continue: WARDBY.slate,
} as const;
type CardKind = keyof typeof CARD_COLOR;
// What each card's bar stands for, as its SVG's alt (the element needs one to be drawn).
const CARD_ALT: Record<CardKind, string> = {
  started: "Started by",
  produced: "What it produced",
  tree: "Run tree",
  final: "Final answer",
  services: "Services",
  steps: "Steps",
  error: "Error",
  continue: "Continue locally",
};
// Shell tools: their rows show the command alone, since nearly every step is one.
const SHELL_TOOLS = new Set(["Bash", "shell", "exec", "exec_command", "run_command", "local_shell"]);
// A failed step's exit code sits on a soft tint of wardby red (14%, see-through on light and dark).
const FAIL_TINT = "#e33d3724";
// The open step's inset panel, and a said step's quiet left rule.
const WELL_BG = "#a8a29e14";
const RULE_BG = "#a8a29e33";

/** A card's colour bar for the desktop: a full-width strip, stretched to the width it is drawn at. */
function cardBarSvg(fill: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="3" viewBox="0 0 2000 3" preserveAspectRatio="none">` +
    `<rect width="2000" height="3" fill="${fill}" /></svg>`
  );
}
/** A run status's tone: running blue, pending grey, succeeded green, anything else (failed, stopped, …) red. */
const statusTone = (status: string): Tone =>
  status === "running" ? "blue" : status === "pending" ? "grey" : status === "succeeded" ? "green" : "red";

/** What a run produced, as a pill: a pull request, a comment, a check or a Jira comment. */
function outcomeTag(kind: string, text: string): { label: string; tone: Tone } {
  if (kind === "pull_request") return { label: "PR", tone: "blue" };
  if (kind === "check") return { label: "check", tone: text.includes("pending") ? "amber" : "green" };
  if (kind === "issue_comment") return { label: "Jira", tone: "blue" };
  return { label: kind || "comment", tone: "grey" };
}

/** A coding-run service's state as a pill: ready, starting (pending or probing), failed. */
function serviceTag(state: string): { label: string; tone: Tone } | null {
  if (state === "ready") return { label: "ready", tone: "green" };
  if (state === "pending" || state === "probing") return { label: "starting", tone: "amber" };
  if (state === "failed") return { label: "failed", tone: "red" };
  return null;
}

/** A run id cut to its ends for the detail header: "cmw8…xqqw". */
const shortId = (id: string): string => (id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id);

/**
 * Text cut to about `max` rows of `width` columns, for a collapsed Request or Final answer: whole lines
 * while they fit, then the next one cut at a word, and how many rows are left. A row is a line, or a
 * width's worth of a long one; blank lines are kept between shown lines but not counted.
 */
function collapse(text: string, width: number, max = 3): { text: string; more: number } {
  const cols = Math.max(20, width);
  const rowsOf = (line: string) => Math.max(1, Math.ceil(line.length / cols));
  const lines = text.split("\n");
  const total = lines.reduce((sum, line) => sum + (line.trim() === "" ? 0 : rowsOf(line)), 0);
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      if (out.length > 0) out.push("");
      continue;
    }
    const rows = rowsOf(line);
    if (used + rows <= max) {
      out.push(line);
      used += rows;
      if (used === max) break;
      continue;
    }
    const room = (max - used) * cols;
    const cut = line.lastIndexOf(" ", room);
    out.push(`${line.slice(0, cut > room / 2 ? cut : room).trimEnd()}…`);
    used = max;
    break;
  }
  return { text: out.join("\n").trimEnd(), more: Math.max(0, total - used) };
}

/** The share of its budget a run has spent (0 without a budget). */
const budgetShare = (row: RunRow): number => (row.budgetUsd ? row.costUsd / row.budgetUsd : 0);

/** A budget's colour: the run's status, amber from 80% of the budget, red at it (a theme name). */
function budgetColor(row: RunRow): string {
  const share = budgetShare(row);
  if (share >= 1) return FAILED_COLOR;
  if (share >= 0.8) return WARN_COLOR;
  return statusColor(row.status);
}

/** The same, as a colour an SVG bar can draw. */
function budgetHex(row: RunRow): string {
  const share = budgetShare(row);
  if (share >= 1) return SVG_FAILED;
  if (share >= 0.8) return SVG_WARN;
  return svgStatus(row.status);
}

const statusColor = (status: string): string => STATUS_COLOR[status] ?? FAILED_COLOR;

/** A list row's spend: "$0.21 of $1.00", or "$0.21" without a budget. */
const costOf = (row: RunRow): string =>
  row.budgetUsd ? `${usd(row.costUsd)} of ${usd(row.budgetUsd)}` : usd(row.costUsd);

/** A desktop list row's meta line: what started it, its task as one short line, and how long it ran. */
function metaOf(row: RunRow, now: number): string {
  const trigger = `${triggerLabel(row.trigger)}${row.parentRunId ? " (from a lead run)" : ""}`;
  const task = taskLine(row.task);
  return [trigger.charAt(0).toUpperCase() + trigger.slice(1), task, took(row, now)].filter(Boolean).join(" · ");
}
const statusMark = (status: string): string =>
  status === "running" ? "●" : status === "pending" ? "○" : status === "succeeded" ? "✓" : "✗";

/** The address a run's name links to in the desktop list; the pane catches the press, and .invalid never resolves. */
const runHref = (id: string): string => `https://wardby.invalid/run/${encodeURIComponent(id)}`;

/**
 * A task as one short line: wardby wraps follow-up tasks in bracketed context and quotes whole reviews,
 * so the first plain line is kept, without a trailing "(head <sha>)." and cut to `max` characters.
 */
function taskLine(task: string | null, max = 90): string | null {
  if (!task) return null;
  const line = task
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "" && !part.startsWith("[") && !part.startsWith("<"));
  if (!line) return null;
  const tidy = line.replace(/\s*\(head [0-9a-f]{7,40}\)\.?$/i, "").replace(/[.:]$/, "");
  return tidy.length > max ? `${tidy.slice(0, max - 1)}…` : tidy;
}

/** A budget bar as SVG for the desktop: a rounded track and the share spent, in the run's status colour. */
function budgetSvg(cost: number, budget: number, widthPx: number, fill: string, heightPx = 6): string {
  const share = Math.max(0, Math.min(1, cost / budget));
  const filled = share > 0 ? Math.max(3, Math.round(share * widthPx)) : 0;
  const r = heightPx / 2;
  // Stretched to the width it is drawn at: drawn without a width, it takes the room it has.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" ` +
    `viewBox="0 0 ${widthPx} ${heightPx}" preserveAspectRatio="none">` +
    `<rect width="${widthPx}" height="${heightPx}" rx="${r}" fill="${SVG_TRACK}" />` +
    `<rect width="${filled}" height="${heightPx}" rx="${r}" fill="${fill}" /></svg>`
  );
}

function bar(cost: number, budget: number | null, width: number): string {
  if (!budget || budget <= 0) return "";
  const filled = Math.min(width, Math.round((cost / budget) * width));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

export const register: Register = (on, options) => {
  const server = String(options.server ?? "wardby");
  // While a run is active the pane refreshes every pollSeconds; with nothing active, every idleSeconds.
  const activeMs = Math.max(5, Number(options.pollSeconds ?? 10)) * 1000;
  const idleMs = Math.max(activeMs / 1000, Number(options.idleSeconds ?? 60)) * 1000;
  let agents: Agent[] = [];
  let polls = 0;
  let isPolling = false;
  // Whether the server lists runs across agents: unknown until the first poll.
  let acrossAgents: boolean | null = null;
  // Whether the server has get_run_steps and records steps: unknown until asked, and asked again
  // every AGENTS_EVERY polls after a no or an off, since a server may be upgraded or reset.
  let stepsSupport: "unknown" | "yes" | "no" | "off" = "unknown";
  // When the next refresh is due, and the last successful one's time (the next `since`).
  let nextAt = 0;
  let lastOkAt = 0;
  let failures = 0;
  // Polls only while the pane is open, so a closed pane never keeps a server
  // that sleeps when idle awake.
  let timer: { cancel: () => void } | null = null;

  on("session.start", async ($, e, next) => {
    const call: Call = async (tool, args) => parseResult(tool, await $.mcp.call(server, tool, args));

    async function refresh(): Promise<void> {
      if (isPolling) return;
      isPolling = true;
      try {
        const now = await $.clock.now();
        let rows: RunRow[];
        // An older server may be upgraded under the pane: ask again now and then.
        if (acrossAgents === false && polls % AGENTS_EVERY === 0) acrossAgents = null;
        if ((stepsSupport === "no" || stepsSupport === "off") && polls % AGENTS_EVERY === 0) stepsSupport = "unknown";
        if (acrossAgents !== false) {
          // One call: list_runs without an agentId (wardby 0.8.0+).
          try {
            const isFull = lastOkAt === 0 || polls % FULL_EVERY === 0;
            const since = new Date(isFull ? now - RECENT_MS : lastOkAt - OVERLAP_MS).toISOString();
            const list = (await call("list_runs", { since, limit: 100 })) as Record<string, unknown>[];
            const changed = list.map((run) =>
              toRow(run, {
                id: String(run.agentId),
                name: String(run.agentName ?? run.agentId),
                budgetUsd: run.agentBudgetUsd == null ? null : Number(run.agentBudgetUsd),
              }),
            );
            // An incremental reply holds only what changed (plus anything active): merge it in.
            const merged = new Map(isFull ? [] : (await read($, runs)).map((row) => [row.id, row]));
            for (const row of changed) merged.set(row.id, row);
            rows = [...merged.values()];
            acrossAgents = true;
          } catch (err) {
            // An older server requires agentId: fall back to one call per agent.
            if (acrossAgents === true || !/agentId/i.test(err instanceof Error ? err.message : "")) throw err;
            acrossAgents = false;
            rows = await perAgentRows();
          }
        } else {
          rows = await perAgentRows();
        }
        polls += 1;
        const fresh = visible(rows, now);
        const before = new Map((await read($, runs)).map((row) => [row.id, row.status]));
        for (const row of fresh) {
          const was = before.get(row.id);
          if (was && ACTIVE.has(was) && !ACTIVE.has(row.status)) {
            $.ui.toast(`wardby · ${row.agentName} ${row.status} in ${took(row, now)} (${usd(row.costUsd)})`);
          }
        }
        await update($, runs, () => fresh);
        await update($, poll, (): Poll => ({ at: now, error: null }));
        failures = 0;
        lastOkAt = now;
        const active = fresh.filter((row) => ACTIVE.has(row.status)).length;
        nextAt = now + (active > 0 ? activeMs : idleMs);
        $.ui.status(active > 0 ? `wardby: ${active} running` : undefined);
        const open = await read($, selected);
        // The open run: while it runs, and once more when it has just finished (its final answer, its steps).
        const openRow = open ? fresh.find((row) => row.id === open) : undefined;
        if (openRow && (ACTIVE.has(openRow.status) || ACTIVE.has(before.get(openRow.id) ?? ""))) {
          await loadDetail(openRow.id);
        }
      } catch (err) {
        const now = await $.clock.now();
        const raw = err instanceof Error ? err.message : "could not reach the wardby server";
        // Auto mode gates a mod's MCP calls too; say how to allow the read-only tools.
        const message = /auto mode/i.test(raw)
          ? `auto mode refused the call. Allow mcp__${server}__list_runs, mcp__${server}__list_agents, mcp__${server}__get_run and mcp__${server}__get_run_steps in /permissions, then press r.`
          : raw;
        await update($, poll, (): Poll => ({ at: now, error: message }));
        failures += 1;
        // Back off a failing or rate-limiting server: double the wait each time, up to MAX_BACKOFF_MS.
        nextAt = now + Math.min(MAX_BACKOFF_MS, activeMs * 2 ** (failures - 1));
      } finally {
        isPolling = false;
      }
    }

    /** The older server's path: list_agents (summary when the server has it), then list_runs per agent. */
    async function perAgentRows(): Promise<RunRow[]> {
      if (agents.length === 0 || polls % AGENTS_EVERY === 0) {
        const list = (await call("list_agents", { summary: true })) as Record<string, unknown>[];
        agents = list.map((agent) => ({
          id: String(agent.id),
          name: String(agent.name),
          budgetUsd: agent.budgetUsd == null ? null : Number(agent.budgetUsd),
        }));
      }
      const perAgent = await Promise.all(
        agents.map(async (agent) => {
          try {
            const list = (await call("list_runs", { agentId: agent.id, limit: PER_AGENT })) as Record<
              string,
              unknown
            >[];
            return list.map((run) => toRow(run, agent));
          } catch {
            return [];
          }
        }),
      );
      return perAgent.flat();
    }

    async function loadDetail(runId: string): Promise<void> {
      try {
        const run = (await call("get_run", { runId })) as Record<string, unknown>;
        const info = toDetail(run);
        // A late reply for a run that is no longer open must not overwrite the open run's detail.
        if ((await read($, selected)) !== runId) return;
        await update($, detail, () => info);
        await loadSteps(runId, ACTIVE.has(String(run.status)), info.lastStepSeq);
      } catch (err) {
        const now = await $.clock.now();
        await update($, poll, (p): Poll => ({
          at: p.at || now,
          error: err instanceof Error ? err.message : "get_run failed",
        }));
      }
    }

    /**
     * A run's steps, through get_run_steps. A running run: the window of its last RECENT_STEPS, from
     * its newest seq, read again on every poll so a status that arrives later shows. A finished run:
     * from the start, a page at a time (`more` asks for the next). Steps are drawn as the server stored
     * them, already redacted; the pane adds only fixed wording. Never throws: a failure here never
     * hides the run or sets the pane's error line.
     */
    let moreInFlight = false;
    async function loadSteps(runId: string, isActive: boolean, lastSeq: number | null, more = false): Promise<void> {
      const mode: Steps["mode"] = isActive ? "recent" : "all";
      const blank: Steps = {
        runId,
        mode,
        level: null,
        steps: [],
        next: null,
        dropped: 0,
        expired: false,
        notice: null,
      };
      try {
        if (stepsSupport === "no") {
          await update($, runSteps, () => null);
          return;
        }
        if (stepsSupport === "off") {
          await update($, runSteps, (): Steps => ({ ...blank, level: "off" }));
          return;
        }
        const current = await read($, runSteps);
        const same = current?.runId === runId && current.mode === mode;
        if (mode === "all" && same && !more && current.notice === null) return;
        const after =
          mode === "recent" ? Math.max(0, (lastSeq ?? 0) - RECENT_STEPS) : more && same ? (current.next ?? 0) : 0;
        if (more) {
          // A second press before the first reply would read the same cursor and append the page twice.
          if (moreInFlight) return;
          moreInFlight = true;
        }
        let reply: Record<string, unknown>;
        try {
          reply = (await call("get_run_steps", { runId, after, limit: STEPS_PAGE })) as Record<string, unknown>;
        } finally {
          if (more) moreInFlight = false;
        }
        stepsSupport = reply.level === "off" ? "off" : "yes";
        // A late reply for a run that is no longer open is dropped: it must not replace the open run's steps.
        if ((await read($, selected)) !== runId) return;
        const got = toSteps(reply.steps);
        const fresh = await read($, runSteps);
        const kept = more && fresh?.runId === runId && fresh.mode === mode ? fresh.steps : [];
        const seen = new Set(kept.map((st) => st.seq));
        await update($, runSteps, (): Steps => ({
          ...blank,
          level: str(reply.level),
          steps: mode === "recent" ? got.slice(-RECENT_STEPS) : [...kept, ...got.filter((st) => !seen.has(st.seq))],
          next: typeof reply.next === "number" ? reply.next : null,
          dropped: num(reply.dropped),
          expired: reply.expired === true,
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        if (/auto mode/i.test(message)) {
          await update($, runSteps, (): Steps => ({
            ...blank,
            notice: `Allow mcp__${server}__get_run_steps in /permissions to see this run's steps.`,
          })).catch(() => {});
        } else if (UNKNOWN_TOOL.test(message)) {
          // An older server: no steps UI for it until the next re-probe.
          stepsSupport = "no";
          await update($, runSteps, () => null).catch(() => {});
        }
        // Anything else (a network blip): keep what is shown; the next poll asks again.
      }
    }

    /**
     * Continue locally: get the run's transcript link and hand it to `wardby resume - --print` on stdin,
     * run in a clone of the repository. The link stays in this function: it is never drawn, stored or
     * logged, and is cut out of the command's output before that is kept.
     */
    async function continueLocally(runId: string, dir: string): Promise<void> {
      await update($, resume, (): Resume => ({ runId, dir, phase: "running", output: "", command: null }));
      let url: string | null = null;
      try {
        const info = (await call("get_run_transcript", { runId })) as Record<string, unknown>;
        const download = info.download as { url?: unknown } | undefined;
        if (info.status !== "stored" || typeof download?.url !== "string") {
          const why = [info.status, info.reason].filter(Boolean).join(": ") || "no transcript stored";
          throw new Error(`no transcript to continue (${why})`);
        }
        url = download.url;
        const result = await $.process.run(["npx", "-y", "@wardby/cli@latest", "resume", "-", "--print"], {
          cwd: dir,
          stdin: `${url}\n`,
          timeoutMs: 5 * 60 * 1000,
        });
        const scrub = (text: string) => (url ? text.split(url).join("[link]") : text);
        const output = scrub(`${result.stdout}\n${result.stderr}`).trim().slice(-3000);
        // The printed command (`cd '<checkout>' && claude ...`) is the end of stdout; its quoted note may span lines.
        const stdout = scrub(result.stdout);
        const start = stdout.search(/(^|\n)cd .* && claude /);
        const command = start >= 0 ? stdout.slice(start).trim() : null;
        await update($, resume, (): Resume => ({
          runId,
          dir,
          phase: result.exitCode === 0 ? "done" : "error",
          output,
          command,
        }));
      } catch (err) {
        const raw = err instanceof Error ? err.message : "could not continue the run";
        const message = url ? raw.split(url).join("[link]") : raw;
        await update($, resume, (): Resume => ({
          runId,
          dir,
          phase: "error",
          output: /auto mode/i.test(message)
            ? `auto mode refused the call. Allow mcp__${server}__get_run_transcript in /permissions, then try again.`
            : message.slice(0, 600),
          command: null,
        }));
      } finally {
        url = null;
      }
    }

    pane.continueLocally = continueLocally;
    // Only for suggesting where to import; the pane works without it.
    pane.cwd = await $.session.cwd().catch(() => "");
    pane.loadDetail = loadDetail;
    pane.loadMoreSteps = (runId) => loadSteps(runId, false, null, true);
    pane.refresh = refresh;
    pane.start = () => {
      timer ??= $.clock.every(TICK_MS, () => {
        void $.clock.now().then((now) => {
          if (now >= nextAt) void refresh();
        });
      });
      void refresh();
    };
    await $.command.register({
      name: "wardby-runs",
      description: "Show your wardby agent runs in a pane (/wardby-runs close | clear)",
    });

    return next(e);
  });

  // Set in session.start, where the MCP call is bound; the pane's buttons reach it here.
  const pane: {
    loadDetail: (runId: string) => Promise<void>;
    loadMoreSteps: (runId: string) => Promise<void>;
    refresh: () => Promise<void>;
    start: () => void;
    continueLocally: (runId: string, dir: string) => Promise<void>;
    cwd: string;
  } = {
    loadDetail: async () => {},
    loadMoreSteps: async () => {},
    refresh: async () => {},
    start: () => {},
    continueLocally: async () => {},
    cwd: "",
  };

  /** Where the pane suggests importing: a local: repository's own path, else a sibling of this session's folder. */
  function suggestedDir(repository: string | null): string {
    if (!repository) return pane.cwd;
    if (repository.startsWith("local:")) return repository.slice("local:".length);
    const name = repository.split("/").pop() ?? repository;
    const parent = pane.cwd.replace(/\/[^/]*\/?$/, "");
    return parent ? `${parent}/${name}` : name;
  }

  on("command.run", { command: "wardby-runs" }, async ($, e) => {
    if ((e.args ?? "").trim() === "clear") {
      await update($, filter, (): Filter => ({ status: "all", text: "" }));
      return { text: "wardby runs filter cleared." };
    }
    if ((e.args ?? "").trim() === "close") {
      await $.ui.close({ id: PANE });
      return { text: "wardby runs pane closed." };
    }
    // Beside the transcript in a fullscreen terminal (the dock); above the prompt otherwise.
    await $.ui.open({ id: PANE, title: "wardby runs", focus: true, closeOnEscape: true, columns: 56 });
    pane.start();

    return { text: "wardby runs pane opened. Escape, x or /wardby-runs close closes it." };
  });

  on("ui.close", async ($, e, next) => {
    if (e.id === PANE) {
      timer?.cancel();
      timer = null;
      $.ui.status(undefined);
    }
    return next(e);
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e);
    const { Box, Text, Button, Link, Markdown } = elements;
    // The strips' dots are SVG, drawn only where the surface has it (the desktop).
    const Svg = "Svg" in elements ? elements.Svg : null;
    // A text box only where the surface has one (terminal and desktop); elsewhere the status buttons alone.
    const Input = "Input" in elements ? elements.Input : null;
    // A reload drops the timer but keeps the pane open: a drawn pane polls.
    if (!timer) pane.start();
    const now = await $.clock.now();
    const status = await read($, poll);
    const openId = await read($, selected);
    const rows = await read($, runs);
    const width = Math.max(24, (e.props.bodyColumns ?? 40) - 2);
    const isDesktop = e.surface === "desktop";
    /**
     * A status pill: on the desktop a word on a soft tint of its colour; on the terminal, which paints no
     * tint, the word in its colour, after `mark` when given ("● running") or in brackets ("[ready]").
     */
    const pill = (label: string, tone: Tone, mark?: string) =>
      isDesktop ? (
        <Text backgroundColor={TONES[tone].bg} color={TONES[tone].fg} weight="medium" size="caption">
          {` ${label || mark || ""} `}
        </Text>
      ) : (
        <Text color={TONES[tone].fg}>{mark ? (label ? `${mark} ${label}` : mark) : `[${label}]`}</Text>
      );

    const header = (
      <Box flexDirection="column">
        <Box gap={1}>
          <Button
            key="refresh"
            label="Refresh"
            {...(e.surface === "desktop" ? {} : { hotkey: "r" })}
            onPress={() => void pane.refresh()}
          />
          {/* The desktop pane has its own close control. */}
          {e.surface !== "desktop" && (
            <Button key="close" label="Close" hotkey="x" onPress={() => void $.ui.close({ id: PANE })} />
          )}
          <Text dimColor wrap="truncate-end">
            {status.at ? `Updated ${ago(new Date(status.at).toISOString(), now)} ago` : "Loading…"}
          </Text>
        </Box>
        {status.error && <Text color={FAILED_COLOR}>wardby: {status.error}</Text>}
      </Box>
    );

    const open = openId ? rows.find((row) => row.id === openId) : undefined;
    if (open) {
      const info = await read($, detail);
      const resumeState = await read($, resume);
      const isFull = (await read($, expanded)) === open.id;
      const D = isDesktop;
      // Keys are for the terminal, where the keyboard is the way in; the desktop takes clicks.
      const hk = (key: string) => (D ? {} : { hotkey: key });
      // Section headings: plain, semibold, sentence case.
      const heading = (text: string) =>
        D ? (
          <Text weight="semibold" size="footnote">
            {text}
          </Text>
        ) : (
          <Text bold>{text}</Text>
        );
      /**
       * Copies text the pane already holds (as the server sent it, already redacted) and says how it went.
       * Never adds a field: each section copies exactly what it was given.
       */
      const copyText = (text: string) => (press: { surface: UiCopyArgs["surface"] }) =>
        void $.ui
          .copy({ text, surface: press.surface })
          .then((result) => $.ui.toast(result.isCopied ? "Copied" : "Couldn't copy"))
          .catch(() => $.ui.toast("Couldn't copy"));
      /**
       * Each section is a rounded card with its kind's colour from the wardby.com palette: on the desktop a
       * thin bar along the card's top (the theme's prompt-box border stays, visible in light and dark); on
       * the terminal, which draws no SVG, the card's rounded border in that colour.
       */
      const card = (key: string, kind: CardKind, children: unknown) => (
        <Box key={key} flexDirection="column" {...GROUP_BOX} {...(D && Svg ? {} : { borderColor: CARD_COLOR[kind] })}>
          {D && Svg && (
            <Box key={`${key}-bar`} marginBottom="sm">
              <Svg source={cardBarSvg(CARD_COLOR[kind])} alt={`${CARD_ALT[kind]} card`} height={3} />
            </Box>
          )}
          {children as never}
        </Box>
      );
      /** A card's heading row: the heading, and on the desktop a small Copy button at its right. */
      const headingRow = (key: string, text: string, copy: string | null) =>
        D && copy !== null ? (
          <Box key={`${key}-head`} alignItems="center">
            {heading(text)}
            <Box flexGrow={1} />
            <Button key={`copy-${key}`} label="Copy" dimColor onPress={copyText(copy)} />
          </Box>
        ) : (
          heading(text)
        );
      // The room inside a card, for cutting collapsed text to about three rows.
      const inner = Math.max(20, width - 4);
      /** Collapsed long text: about three rows, then how many are left; the whole of it when expanded. */
      const folded = (key: string, text: string, asMarkdown: boolean, dim = false) => {
        const cut = isFull ? { text, more: 0 } : collapse(text, inner);
        return (
          <Box key={key} flexDirection="column">
            {asMarkdown && Markdown ? (
              <Markdown key={`${key}-text`} text={cut.text} {...(dim ? { dimColor: true } : {})} />
            ) : (
              <Text wrap="wrap" {...(dim ? { dimColor: true } : {})}>
                {cut.text}
              </Text>
            )}
            {cut.more > 0 && (
              <Box key={`${key}-more`}>
                <Text color={TONES.blue.fg} size="caption">
                  … {cut.more} more {cut.more === 1 ? "line" : "lines"}
                  {D ? "" : " (m)"}
                </Text>
              </Box>
            )}
          </Box>
        );
      };
      const shown = info && info.id === open.id ? info : null;
      // The long texts the detail shows, and whether any is cut: that is when Show full text has work to do.
      const longTexts = [shown?.request ?? open.task, shown?.finalText].filter((text): text is string => !!text);
      const hasLong = longTexts.some((text) => collapse(text, inner).more > 0);
      const cursor = await read($, openStep);
      const stepsState = await read($, runSteps);
      const stepsOf = stepsState?.runId === open.id ? stepsState : null;
      // Steps as stored (already redacted), as plain Text: a summary never becomes markdown or a link.
      // Each key sits on a wrapping Box (the test kit drops `key` on Text).
      const stepsBlock = (() => {
        if (!stepsOf) return null;
        if (stepsOf.notice) {
          return (
            <Box key="steps-notice">
              <Text dimColor wrap="wrap">
                {stepsOf.notice}
              </Text>
            </Box>
          );
        }
        if (stepsOf.level === "off") {
          return (
            <Box key="steps-off">
              <Text dimColor>Steps are off on this server.</Text>
            </Box>
          );
        }
        if (stepsOf.steps.length === 0) {
          // Nothing recorded (yet, or not for this kind of run on this server): say nothing rather than guess.
          return stepsOf.expired ? (
            <Box key="steps-expired">
              <Text dimColor>This run's steps were deleted after the retention period.</Text>
            </Box>
          ) : null;
        }
        const isRecent = stepsOf.mode === "recent";
        // What the model said is cut to about two rows of the room beside the gutter and the chevron.
        const saidCut = (step: Step) => collapse(step.summary, Math.max(20, inner - 8), 2);
        // A step opens when it has detail, or when it is something said that does not fit its two rows.
        const canOpen = (step: Step) => step.detail !== null || (step.kind !== "tool" && saidCut(step).more > 0);
        const openSeqs = stepsOf.steps.filter(canOpen).map((s) => s.seq);
        return card(
          "steps-card",
          "steps",
          <>
            <Box key="steps-head">
              {heading(isRecent ? "Recent steps" : "Steps")}
              <Box flexGrow={1} />
              {stepsOf.level &&
                stepsOf.level !== "off" &&
                pill(stepsOf.level, stepsOf.level === "detail" ? "amber" : "grey")}
            </Box>
            {stepsOf.steps.map((step) => {
              const isTool = step.kind === "tool";
              const result = stepMark(step);
              const openable = canOpen(step);
              const isCursor = cursor?.runId === open.id && cursor.seq === step.seq;
              const isOpen = openable && isCursor && cursor.open;
              const toggle = () =>
                void update($, openStep, (current): OpenStep => ({
                  runId: open.id,
                  seq: step.seq,
                  open: !(current?.runId === open.id && current.seq === step.seq && current.open),
                }));
              // The gutter: ✓ in wardby mint, a failure's exit code (or ! for an error) in wardby red on a
              // soft red tint, … while it runs; nothing for what the model said. The terminal draws theme
              // colours, and the cursor before the mark.
              const markColor = (failed: boolean, mark: string) =>
                failed ? (D ? WARDBY.red : FAILED_COLOR) : mark === "✓" ? (D ? WARDBY.mint : "success") : TONES.blue.fg;
              const gutter = D ? (
                <Box key={`step-mark-${step.seq}`} width={4} flexShrink={0} justifyContent="center">
                  {result &&
                    (result.failed ? (
                      <Text mono size="caption" weight="semibold" color={WARDBY.red} backgroundColor={FAIL_TINT}>
                        {result.mark}
                      </Text>
                    ) : (
                      <Text weight="semibold" color={markColor(false, result.mark)}>
                        {result.mark}
                      </Text>
                    ))}
                </Box>
              ) : (
                <Box key={`step-mark-${step.seq}`} width={5} flexShrink={0}>
                  <Text>
                    {isCursor ? "› " : "  "}
                    {result ? (
                      <Text color={markColor(result.failed, result.mark)}>{result.mark}</Text>
                    ) : (
                      <Text dimColor>│</Text>
                    )}
                  </Text>
                </Box>
              );
              // Plain text only: a summary or detail never becomes markdown or a link.
              const said = isOpen ? detailHead(step.detail ?? step.summary) : { ...saidCut(step), hidden: 0 };
              const content = isTool ? (
                D ? (
                  // The tool small and dim, the command in mono on one line, cut with … rather than overflowing.
                  <Box flexGrow={1} flexShrink={1} minWidth={0} gap={1} alignItems="center">
                    {!SHELL_TOOLS.has(step.tool ?? "") && (
                      <Box flexShrink={0}>
                        <Text size="caption" dimColor>
                          {step.tool ?? "tool"}
                        </Text>
                      </Box>
                    )}
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      <Text mono size="footnote" wrap="truncate-end">
                        {step.summary}
                      </Text>
                    </Box>
                  </Box>
                ) : (
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="wrap">{stepText(step)}</Text>
                  </Box>
                )
              ) : (
                // What the model said: wrapped, never past the right edge, after a quiet rule on the desktop
                // (a narrow tinted column, as a Box has no one-sided border).
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  {D && <Box key={`step-rule-${step.seq}`} width={1} flexShrink={0} backgroundColor={RULE_BG} />}
                  <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} paddingLeft={D ? 1 : 0}>
                    <Text dimColor wrap="wrap">
                      {said.text}
                    </Text>
                    {said.hidden > 0 && (
                      <Text dimColor size="caption">
                        … {said.hidden} more {said.hidden === 1 ? "line" : "lines"}
                      </Text>
                    )}
                    {D && isOpen && step.detail !== null && (
                      <Box key={`step-said-copy-${step.seq}`}>
                        <Box flexGrow={1} />
                        <Button key={`copy-step-${step.seq}`} label="Copy" dimColor onPress={copyText(step.detail)} />
                      </Box>
                    )}
                  </Box>
                </Box>
              );
              // The row's one control: a one-glyph chevron, ▸ closed and ▾ open.
              const chevron = openable && (
                <Box key={`step-chevron-${step.seq}`} flexShrink={0}>
                  <Button
                    key={`step-detail-${step.seq}`}
                    plain
                    label={isOpen ? "▾" : "▸"}
                    dimColor
                    {...(D ? { hover: { dimColor: false } } : {})}
                    onPress={toggle}
                  />
                </Box>
              );
              const panel =
                isTool &&
                isOpen &&
                step.detail !== null &&
                (() => {
                  // Stored already redacted; shown as "$ command", its exit status and the output alone (the
                  // detail as stored when it does not read as a command). Its last lines only, so one step
                  // cannot push the pane off the screen. Copy copies the detail as stored.
                  const parts = detailParts(step.detail);
                  const { text, hidden } = detailTail(parts ? parts.output : step.detail);
                  const exitText = parts?.exit != null ? `exit ${parts.exit}` : (step.status ?? "running");
                  const failed =
                    parts?.exit != null ? parts.exit !== "0" : step.status !== null && step.status !== "ok";
                  const status = (
                    <Text size="caption" {...(failed ? { color: D ? WARDBY.red : FAILED_COLOR } : { dimColor: true })}>
                      {exitText}
                    </Text>
                  );
                  return (
                    <Box
                      key={`step-text-${step.seq}`}
                      flexDirection="column"
                      marginLeft={D ? 5 : 2}
                      {...(D ? { backgroundColor: WELL_BG, paddingX: 1 } : {})}
                    >
                      {(D || parts) && (
                        <Box key={`step-head-${step.seq}`} gap={1} alignItems="center">
                          <Box flexGrow={1} flexShrink={1} minWidth={0}>
                            {parts && (
                              <Text mono={D} size="footnote" wrap="wrap">
                                {`$ ${parts.command}`}
                              </Text>
                            )}
                          </Box>
                          {status}
                          {D && (
                            <Button
                              key={`copy-step-${step.seq}`}
                              label="Copy"
                              dimColor
                              onPress={copyText(step.detail)}
                            />
                          )}
                        </Box>
                      )}
                      {hidden > 0 && (
                        <Text dimColor>
                          … {hidden} more {hidden === 1 ? "line" : "lines"}
                        </Text>
                      )}
                      {text !== "" && (
                        <Text dimColor wrap="wrap" mono={D}>
                          {text}
                        </Text>
                      )}
                    </Box>
                  );
                })();
              return (
                <Box key={`step-${step.seq}`} flexDirection="column">
                  <Box
                    key={`step-row-${step.seq}`}
                    gap={1}
                    alignItems={isTool ? "center" : "flex-start"}
                    {...(D
                      ? {
                          hover: { backgroundColor: HIGHLIGHT_BG },
                          ...(isOpen ? { backgroundColor: HIGHLIGHT_BG } : {}),
                        }
                      : {})}
                  >
                    {gutter}
                    {content}
                    {chevron}
                  </Box>
                  {panel}
                </Box>
              );
            })}
            {!D && openSeqs.length > 0 && (
              <Box gap={2}>
                <Button
                  key="step-prev"
                  label="Previous (k)"
                  hotkey="k"
                  onPress={() => void update($, openStep, (c) => moveCursor(c, open.id, openSeqs, -1))}
                />
                <Button
                  key="step-next"
                  label="Next (j)"
                  hotkey="j"
                  onPress={() => void update($, openStep, (c) => moveCursor(c, open.id, openSeqs, 1))}
                />
                <Button
                  key="step-open"
                  label="Show detail (e)"
                  hotkey="e"
                  onPress={() =>
                    void update($, openStep, (c) => {
                      const at =
                        c?.runId === open.id && openSeqs.includes(c.seq) ? c : moveCursor(null, open.id, openSeqs, -1);
                      return at ? { ...at, open: !at.open } : c;
                    })
                  }
                />
                {(() => {
                  // The terminal's one copy key: the open step's detail, as stored.
                  const at = cursor?.runId === open.id && cursor.open ? cursor.seq : null;
                  const text = stepsOf.steps.find((st) => st.seq === at)?.detail ?? null;
                  return text !== null ? (
                    <Button key="copy-section" label="Copy section (y)" hotkey="y" onPress={copyText(text)} />
                  ) : null;
                })()}
              </Box>
            )}
            {!isRecent && stepsOf.next !== null && (
              <Box>
                <Button
                  key="more-steps"
                  label={D ? "More steps" : "More steps (n)"}
                  {...hk("n")}
                  onPress={() => void pane.loadMoreSteps(open.id)}
                />
              </Box>
            )}
            {stepsOf.dropped > 0 && (
              <Box key="steps-dropped">
                <Text dimColor>{`${stepsOf.dropped} later steps were not recorded (the per-run limit).`}</Text>
              </Box>
            )}
          </>,
        );
      })();
      const prOutcome = open.outcomes.find((o) => o.kind === "pull_request" && o.url);
      const prUrl = shown?.pullRequestUrl ?? prOutcome?.url ?? null;
      const prNumber = prUrl ? /\/pull\/(\d+)/.exec(prUrl)?.[1] : null;
      // One dim line under the header: where, which model, how long, and when it finished or was last active.
      const when = open.finishedAt
        ? `finished ${ago(open.finishedAt, now)} ago`
        : open.heartbeatAt
          ? `last active ${ago(open.heartbeatAt, now)} ago`
          : "";
      const meta = [shown?.repository ?? null, shown?.model ?? null, took(open, now), when]
        .filter((part): part is string => !!part)
        .join(" · ");
      const budgetText = open.budgetUsd
        ? `${usd(open.costUsd)} of ${usd(open.budgetUsd)} budget`
        : `${usd(open.costUsd)} spent`;
      const tree = treeOf(rows, open.id);
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            {/* The header: back, the agent, its status, and the short run id at the right. */}
            <Box gap={1} alignItems="center" flexWrap="wrap">
              <Button
                key="back"
                label="‹ Runs"
                {...hk("b")}
                {...(D ? { dimColor: true } : {})}
                onPress={() => {
                  void update($, selected, () => null);
                  void update($, openStep, () => null);
                }}
              />
              <Text size="heading" weight="semibold" bold={!D} wrap="wrap">
                {open.agentName}
              </Text>
              {pill(open.status.replaceAll("_", " "), statusTone(open.status), statusMark(open.status))}
              <Box flexGrow={1} />
              <Text dimColor mono size="caption">
                {shortId(open.id)}
              </Text>
            </Box>
            <Text dimColor size="caption" wrap="wrap">
              {meta}
            </Text>
            {open.budgetUsd ? (
              D && Svg ? (
                <Svg
                  source={budgetSvg(open.costUsd, open.budgetUsd, 480, budgetHex(open))}
                  alt={`${usd(open.costUsd)} of ${usd(open.budgetUsd)} budget`}
                  height={6}
                />
              ) : (
                <Text>
                  <Text color={budgetColor(open)}>{bar(open.costUsd, open.budgetUsd, Math.min(40, width - 2))}</Text>
                </Text>
              )
            ) : null}
            <Box>
              <Text
                size="caption"
                tabular
                {...(budgetShare(open) >= 0.8 ? { color: budgetColor(open) } : { dimColor: true })}
              >
                {budgetText}
              </Text>
              <Box flexGrow={1} />
              <Text dimColor size="caption" tabular>
                turn {open.turns}
              </Text>
            </Box>
          </Box>
          {shown &&
            (shown.error || shown.failureCategory) &&
            // An error reads first, in a red card: what failed, then the plain message.
            card(
              "error-card",
              "error",
              <>
                <Box key="error-head" alignItems="center">
                  <Text color={FAILED_COLOR} weight="semibold" bold>
                    {shown.failureCategory ? shown.failureCategory.replaceAll("_", " ") : "Failed"}
                  </Text>
                  <Box flexGrow={1} />
                  {D && shown.error && (
                    <Button key="copy-error" label="Copy" dimColor onPress={copyText(shown.error)} />
                  )}
                </Box>
                {shown.error && <Text wrap="wrap">{shown.error}</Text>}
              </>,
            )}
          {stepsOf?.mode === "recent" && stepsBlock}
          {(open.via || shown?.request || open.task) &&
            card(
              "started-card",
              "started",
              <>
                {headingRow("started", "Started by", shown?.request ?? open.task ?? null)}
                {open.via && (
                  <Box gap={1}>
                    <Text>
                      {open.via.event === "mention"
                        ? "A mention on"
                        : open.via.event === "review"
                          ? "A review of"
                          : "Issue"}
                    </Text>
                    {open.via.url ? (
                      <Link href={open.via.url} label={open.via.pr.replace(/^issue:/, "")} />
                    ) : (
                      <Text>{open.via.pr.replace(/^issue:/, "")}</Text>
                    )}
                  </Box>
                )}
                {/* What it was asked: the request once loaded (markdown), else the task. */}
                {shown?.request
                  ? folded("request", shown.request, true)
                  : open.task
                    ? folded("task", open.task, false, true)
                    : null}
              </>,
            )}
          {(open.outcomes.length > 0 || (shown && (shown.pullRequestUrl || shown.resultBranch || shown.outcome))) &&
            card(
              "produced-card",
              "produced",
              <>
                {headingRow(
                  "produced",
                  "What it produced",
                  open.outcomes.length > 0
                    ? open.outcomes.map((o) => (o.url ? `${o.text} ${o.url}` : o.text)).join("\n")
                    : shown?.pullRequestUrl
                      ? `Pull request ${shown.pullRequestUrl}`
                      : null,
                )}
                {open.outcomes.map((outcome, i) => {
                  const tag = outcomeTag(outcome.kind, outcome.text);
                  return (
                    <Box key={`outcome-${i}`} gap={1}>
                      {pill(tag.label, tag.tone)}
                      {outcome.url ? (
                        <Link
                          href={outcome.url}
                          label={`${outcome.text.replace(/^opened /, "Opened ")}${outcome.pr ? ` in ${outcome.pr.replace(/#\d+$/, "")}` : ""}`}
                        />
                      ) : (
                        <Text>{outcome.text.charAt(0).toUpperCase() + outcome.text.slice(1)}</Text>
                      )}
                    </Box>
                  );
                })}
                {open.outcomes.length === 0 && shown?.pullRequestUrl && (
                  <Box gap={1}>
                    {pill("PR", "blue")}
                    <Link
                      href={shown.pullRequestUrl}
                      label={`Pull request${prNumber ? ` #${prNumber}` : ""}${shown.repository ? ` in ${shown.repository}` : ""}`}
                    />
                  </Box>
                )}
                {!shown?.pullRequestUrl && shown?.resultBranch && <Text>Pushed branch {shown.resultBranch}</Text>}
                {shown?.outcome && !shown.pullRequestUrl && !shown.resultBranch && (
                  <Text dimColor>{shown.outcome.replaceAll("_", " ")}</Text>
                )}
              </>,
            )}
          {!shown && <Text dimColor>Loading details…</Text>}
          {tree.length >= 2 &&
            card(
              "tree-card",
              "tree",
              <>
                {headingRow(
                  "tree",
                  "Run tree",
                  tree
                    .map(
                      ({ row, depth }) =>
                        `${"  ".repeat(depth)}${[row.agentName, row.status.replaceAll("_", " "), row.id, usd(row.costUsd)].join(" ")}`,
                    )
                    .join("\n"),
                )}
                {tree.map(({ row, depth }) => {
                  const isThis = row.id === open.id;
                  const role = `${depth === 0 ? "lead" : "sub-agent"}${isThis ? " · this run" : ""}`;
                  const indent = depth === 0 ? "" : `${"  ".repeat(depth - 1)}└ `;
                  const mark = pill("", statusTone(row.status), statusMark(row.status));
                  const name = (
                    <Text>
                      <Text dimColor>{indent}</Text>
                      {mark} {isThis ? <Text weight="semibold">{row.agentName}</Text> : row.agentName}{" "}
                      <Text dimColor>{role}</Text>
                    </Text>
                  );
                  return (
                    <Box
                      key={`tree-row-${row.id}`}
                      {...(D && isThis ? { backgroundColor: HIGHLIGHT_BG } : {})}
                      paddingLeft={depth > 0 && D ? 1 : 0}
                    >
                      <Box flexGrow={1} flexShrink={1}>
                        {isThis ? (
                          <Text bold={!D} wrap="truncate-end">
                            {name}
                          </Text>
                        ) : (
                          <Button
                            key={`tree-${row.id}`}
                            onPress={() => {
                              void update($, selected, () => row.id);
                              void pane.loadDetail(row.id);
                            }}
                          >
                            {name}
                          </Button>
                        )}
                      </Box>
                      <Text dimColor size="caption" tabular>
                        {" "}
                        {usd(row.costUsd)} · {took(row, now)}
                      </Text>
                    </Box>
                  );
                })}
              </>,
            )}
          {shown &&
            shown.services.length > 0 &&
            card(
              "services-card",
              "services",
              <>
                {heading("Services")}
                {shown.services.map((label, i) => {
                  const tag = serviceTag(shown.serviceStates[label.split(" ")[0]] ?? "");
                  return (
                    <Box key={`service-${i}`} gap={1}>
                      {tag && pill(tag.label, tag.tone)}
                      <Text>{label}</Text>
                    </Box>
                  );
                })}
              </>,
            )}
          {stepsOf?.mode === "all" && stepsBlock}
          {shown?.finalText &&
            card(
              "final-card",
              "final",
              <>
                {headingRow("final", "Final answer", shown.finalText)}
                {folded("final", shown.finalText, true)}
              </>,
            )}
          {shown &&
            !ACTIVE.has(open.status) &&
            (shown.outcome || shown.resultBranch) &&
            Input &&
            card(
              "continue-card",
              "continue",
              <>
                {heading("Continue locally")}
                {(() => {
                  const state = resumeState?.runId === open.id ? resumeState : null;
                  const dir = state?.dir ?? suggestedDir(shown.repository);
                  return (
                    <Box flexDirection="column">
                      <Input
                        key="resume-dir"
                        label="Clone of the repository"
                        value={dir}
                        onInput={(value: string) =>
                          void update($, resume, (old): Resume => ({
                            runId: open.id,
                            dir: value,
                            phase: old?.runId === open.id ? old.phase : "idle",
                            output: old?.runId === open.id ? old.output : "",
                            command: old?.runId === open.id ? old.command : null,
                          }))
                        }
                        onSubmit={(value: string) => void pane.continueLocally(open.id, value)}
                      />
                      <Box gap={1}>
                        <Button
                          key="continue-locally"
                          label={state?.phase === "running" ? "Importing…" : "Continue locally"}
                          {...hk("c")}
                          onPress={() => {
                            if (state?.phase !== "running") void pane.continueLocally(open.id, dir);
                          }}
                        />
                        {state?.command && (
                          <Button
                            key="copy-command"
                            label="Copy command"
                            onPress={(press) =>
                              void $.ui.copy({ text: state.command as string, surface: press.surface })
                            }
                          />
                        )}
                      </Box>
                      {state?.phase === "done" && state.command && (
                        <Text>Imported. Run this in a terminal to continue the session:</Text>
                      )}
                      {state?.command && (
                        <Text mono wrap="truncate-end">
                          {state.command.length > 160 ? `${state.command.slice(0, 160)}…` : state.command}
                        </Text>
                      )}
                      {state?.phase === "error" && <Text color={FAILED_COLOR}>{state.output.slice(-600)}</Text>}
                      {state?.phase === "done" && !state.command && <Text dimColor>{state.output.slice(-600)}</Text>}
                    </Box>
                  );
                })()}
              </>,
            )}
          {/* Actions: the pull request first, then the quiet ones. */}
          <Box key="actions" gap={2} alignItems="center" flexWrap="wrap">
            {prUrl && <Link href={prUrl} label={prNumber ? `Open pull request #${prNumber}` : "Open pull request"} />}
            {hasLong && (
              <Button
                key="expand"
                label={isFull ? (D ? "Show less" : "Show less (m)") : D ? "Show full text" : "Show full text (m)"}
                {...hk("m")}
                onPress={() => void update($, expanded, (current) => (current === open.id ? null : open.id))}
              />
            )}
            <Button
              key="copy-id"
              label="Copy run id"
              onPress={(press) => void $.ui.copy({ text: open.id, surface: press.surface })}
            />
            {shown?.parentRunId && !rows.some((row) => row.id === shown.parentRunId) && (
              <Button
                key="parent"
                label="Open lead run"
                onPress={() => {
                  void update($, selected, () => shown.parentRunId);
                  void pane.loadDetail(shown.parentRunId as string);
                }}
              />
            )}
          </Box>
        </Box>
      );
    }

    const active = rows.filter((row) => ACTIVE.has(row.status)).length;
    const spent = rows.reduce((sum, row) => sum + row.costUsd, 0);
    const f = await read($, filter);
    const groupToggles = await read($, groupOpen);
    const currentView = await read($, view);
    const pickedSteps = await read($, picked);
    const shown = filtered(rows, f);
    const isFiltered = f.status !== "all" || f.text.trim() !== "";
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {isDesktop ? (
          // One sentence, not tiles: the timeline below is the page's one bold element.
          <Text>
            {(() => {
              const running = rows.filter((row) => row.status === "running").length;
              const queued = rows.filter((row) => row.status === "pending").length;
              const now_ =
                running === 0 && queued === 0
                  ? "Nothing running"
                  : [running ? `${running} running` : "", queued ? `${queued} queued` : ""].filter(Boolean).join(", ");
              return `${now_}. ${usd(spent)} spent today.`;
            })()}
          </Text>
        ) : (
          <Text>
            <Text bold>{active}</Text> active · {rows.length} in the last day · {usd(spent)} spent
          </Text>
        )}
        {isDesktop ? (
          // Two button bars: the view, and which runs to show. The choice in force is the primary button.
          <Box gap={2} flexWrap="wrap" alignItems="center">
            <Box gap={1} alignItems="center">
              <Text dimColor size="caption">
                View
              </Text>
              {(["ledger", "strips"] as const).map((v) => (
                <Button
                  key={`view-${v}`}
                  label={v === "ledger" ? "Ledger" : "Strips"}
                  variant={currentView === v ? "primary" : "secondary"}
                  onPress={() => void update($, view, () => v)}
                />
              ))}
            </Box>
            <Box gap={1} alignItems="center">
              <Text dimColor size="caption">
                Show
              </Text>
              {STATUS_FILTERS.map((choice) => (
                <Button
                  key={`status-${choice.value}`}
                  label={choice.label}
                  variant={f.status === choice.value ? "primary" : "secondary"}
                  onPress={() => void update($, filter, (old): Filter => ({ ...old, status: choice.value }))}
                />
              ))}
            </Box>
          </Box>
        ) : (
          <Box gap={1} flexWrap="wrap">
            {STATUS_FILTERS.map((choice) => (
              <Button
                key={`status-${choice.value}`}
                hotkey={choice.hotkey}
                onPress={() => void update($, filter, (old): Filter => ({ ...old, status: choice.value }))}
              >
                {f.status === choice.value ? <Text bold>[{choice.label}]</Text> : <Text dimColor>{choice.label}</Text>}
              </Button>
            ))}
          </Box>
        )}
        <Box gap={1}>
          {Input && (
            <Input
              key="filter-text"
              placeholder="Filter by agent, status, trigger or task"
              value={f.text}
              onInput={(value: string) => void update($, filter, (old): Filter => ({ ...old, text: value }))}
              onSubmit={(value: string) => void update($, filter, (old): Filter => ({ ...old, text: value }))}
            />
          )}
          {isFiltered && (
            <Button
              key="clear-filter"
              label={e.surface === "desktop" ? "Clear" : "Clear (l)"}
              {...(e.surface === "desktop" ? {} : { hotkey: "l" })}
              onPress={() => void update($, filter, (): Filter => ({ status: "all", text: "" }))}
            />
          )}
        </Box>
        {isFiltered && (
          <Text dimColor>
            {shown.length} of {rows.length} shown
          </Text>
        )}
        {rows.length === 0 && !status.error && <Text dimColor>No runs in the last day.</Text>}
        {rows.length > 0 && shown.length === 0 && <Text dimColor>No runs match the filter.</Text>}
        {isDesktop && currentView === "strips" && (
          // Strips: a card per pull request, its steps as a row of dots, the picked step's detail below.
          <Box flexDirection="column">
            {(() => {
              const groups = asLedger(shown, "oldest");
              const prGroups = groups.filter((group) => group.key !== "other");
              const other = groups.find((group) => group.key === "other");
              return (
                <Box flexDirection="column">
                  {prGroups.map((group) => {
                    const leads = group.rows.filter(({ depth }) => depth === 0);
                    const steps = leads.slice(-STRIP_MAX);
                    const earlier = leads.length - steps.length;
                    const activeLead = [...steps].reverse().find(({ row }) => ACTIVE.has(row.status));
                    const pickedId = pickedSteps[group.key] ?? activeLead?.row.id ?? steps[steps.length - 1]?.row.id;
                    const pickedIndex = Math.max(
                      0,
                      steps.findIndex(({ row }) => row.id === pickedId),
                    );
                    const step = steps[pickedIndex];
                    const children = step ? group.rows.filter(({ row }) => row.parentRunId === step.row.id) : [];
                    const total = group.rows.reduce((sum, { row }) => sum + row.costUsd, 0);
                    return (
                      <Box
                        key={`strip-${group.key}`}
                        flexDirection="column"
                        borderStyle="round"
                        {...(activeLead ? { borderColor: STATUS_COLOR.running } : { borderColor: BORDER_COLOR })}
                        paddingX={1}
                        marginTop={1}
                      >
                        <Box>
                          {group.url ? (
                            <Link href={group.url} label={group.label} />
                          ) : (
                            <Text weight="semibold">{group.label}</Text>
                          )}
                          <Text dimColor size="caption">
                            {" "}
                            {groupState(group)}
                          </Text>
                          <Box flexGrow={1} />
                          <Text weight="semibold" tabular>
                            {usd(total)}
                          </Text>
                        </Box>
                        {/* A column per step: its drawing and, under it, its name as a link, so they line up. */}
                        <Box marginTop={1}>
                          {steps.map(({ row, event }, i) => {
                            const href = `https://wardby.invalid/step/${encodeURIComponent(group.key)}/${encodeURIComponent(row.id)}`;
                            const name = (stepLabel(row, event) || row.agentName).replace(/[[\]*_]/g, "");
                            const isPicked = i === pickedIndex;
                            return (
                              <Box
                                key={`step-${row.id}`}
                                flexDirection="column"
                                alignItems="center"
                                width={STRIP_CELLS}
                                overflow="hidden"
                              >
                                {Svg && (
                                  <Svg
                                    source={stepSvg(row.status, {
                                      isFirst: i === 0,
                                      isLast: i === steps.length - 1,
                                      isPicked,
                                      intoDone: i > 0 && steps[i - 1].row.status === "succeeded",
                                    })}
                                    alt={`${name} ${row.status.replaceAll("_", " ")}`}
                                    width={STRIP_PX}
                                    height={22}
                                  />
                                )}
                                <Markdown
                                  key={`step-link-${row.id}`}
                                  text={isPicked ? `**${name}**` : `[${name}](${href})`}
                                  {...(isPicked
                                    ? {}
                                    : {
                                        pressableLinks: [href],
                                        onLinkPress: () =>
                                          void update($, picked, (current) => ({ ...current, [group.key]: row.id })),
                                      })}
                                />
                              </Box>
                            );
                          })}
                        </Box>
                        {earlier > 0 && (
                          <Markdown
                            key={`earlier-${group.key}`}
                            dimColor
                            text={`[+${earlier} earlier steps](https://wardby.invalid/view/ledger)`}
                            pressableLinks={["https://wardby.invalid/view/ledger"]}
                            onLinkPress={() => void update($, view, () => "ledger")}
                          />
                        )}
                        {step && (
                          <Box flexDirection="column" marginTop={1}>
                            <Box>
                              <Text weight="semibold">{stepName(step.row, step.event)}</Text>
                              <Text dimColor size="caption">
                                {"  "}
                                {ACTIVE.has(step.row.status)
                                  ? `running ${took(step.row, now)}`
                                  : `${step.row.status.replaceAll("_", " ")} in ${took(step.row, now)}`}
                              </Text>
                            </Box>
                            <Markdown
                              key={`run-${step.row.id}`}
                              text={`[${step.row.agentName.replace(/[[\]]/g, "")}](${runHref(step.row.id)}) ${ACTIVE.has(step.row.status) ? "has spent" : "spent"} ${usd(step.row.costUsd)}${step.row.budgetUsd ? ` of ${usd(step.row.budgetUsd)}` : ""}.`}
                              pressableLinks={[runHref(step.row.id)]}
                              onLinkPress={() => {
                                void update($, selected, () => step.row.id);
                                void pane.loadDetail(step.row.id);
                              }}
                            />
                            {children.map(({ row }) => (
                              <Markdown
                                key={`run-${row.id}`}
                                text={`└ ${statusMark(row.status)} [${row.agentName.replace(/[[\]]/g, "")}](${runHref(row.id)}) ${usd(row.costUsd)}`}
                                dimColor
                                pressableLinks={[runHref(row.id)]}
                                onLinkPress={() => {
                                  void update($, selected, () => row.id);
                                  void pane.loadDetail(row.id);
                                }}
                              />
                            ))}
                          </Box>
                        )}
                      </Box>
                    );
                  })}
                  {other ? (
                    <Box flexDirection="column" marginTop={1}>
                      <Text dimColor size="caption">
                        Other runs
                      </Text>
                      {other.rows.map(({ row }) => (
                        <Box key={`other-${row.id}`}>
                          <Text color={statusColor(row.status)} weight="semibold">
                            {statusMark(row.status)}{" "}
                          </Text>
                          <Markdown
                            key={`run-${row.id}`}
                            text={`[${row.agentName.replace(/[[\]]/g, "")}](${runHref(row.id)})${!ACTIVE.has(row.status) && row.status !== "succeeded" ? `  ${row.status.replaceAll("_", " ")}` : ""}`}
                            pressableLinks={[runHref(row.id)]}
                            onLinkPress={() => {
                              void update($, selected, () => row.id);
                              void pane.loadDetail(row.id);
                            }}
                          />
                          <Box flexGrow={1} />
                          <Text dimColor size="caption" tabular>
                            {took(row, now)}
                          </Text>
                        </Box>
                      ))}
                    </Box>
                  ) : null}
                </Box>
              );
            })()}
          </Box>
        )}
        {isDesktop && currentView === "ledger" && (
          // The ledger: a group row per pull request, collapsible, then one line per run.
          <Box flexDirection="column">
            {asLedger(shown).map((group) => {
              const total = group.rows.reduce((sum, { row }) => sum + row.costUsd, 0);
              const isActive = group.rows.some(({ row }) => ACTIVE.has(row.status));
              // Open by default while a run is going, after a failure, and for the runs that touch no
              // pull request; finished pull requests start folded. What the person toggles wins.
              const isOpen =
                groupToggles[group.key] ?? (group.key === "other" || isActive || groupColor(group) === FAILED_COLOR);
              const toggleHref = `https://wardby.invalid/group/${encodeURIComponent(group.key)}`;
              const clean = (text: string) => text.replace(/[[\]*_]/g, "");
              /** One run as a ledger line; `withPr` adds the pull request's link (a one-run group's only line). */
              const runLine = ({ row, depth, event }: LedgerGroup["rows"][number], withPr = false) => {
                const label = depth === 0 ? stepLabel(row, event) : "└";
                const pr =
                  withPr && group.url
                    ? `  [${clean(group.label)} ↗](${group.url})`
                    : withPr
                      ? `  ${clean(group.label)}`
                      : "";
                const indent = depth > 0 ? 3 : 0;
                return (
                  <Box key={row.id} flexDirection="column" marginTop={1}>
                    {/* The status pill and the agent, "$x of $y" at the right. */}
                    <Box alignItems="center" marginLeft={indent}>
                      {pill(row.status.replaceAll("_", " "), statusTone(row.status))}
                      <Box flexGrow={1} flexShrink={1} marginLeft={1}>
                        <Markdown
                          key={`run-${row.id}`}
                          text={`${label ? `${label}  ` : ""}${openId === row.id ? "**" : ""}[${clean(row.agentName)}](${runHref(row.id)})${openId === row.id ? "**" : ""}${pr}`}
                          pressableLinks={[runHref(row.id)]}
                          onLinkPress={() => {
                            void update($, selected, () => row.id);
                            void pane.loadDetail(row.id);
                          }}
                        />
                      </Box>
                      <Text
                        tabular
                        size="caption"
                        {...(budgetShare(row) >= 0.8 ? { color: budgetColor(row) } : { dimColor: true })}
                      >
                        {costOf(row)}
                      </Text>
                    </Box>
                    {showsLastLine(row) && (
                      <Box key={`last-${row.id}`} marginLeft={indent}>
                        <Text dimColor size="caption" wrap="truncate-end">
                          ↳ {row.lastLine}
                        </Text>
                      </Box>
                    )}
                    <Box marginLeft={indent}>
                      <Text dimColor size="caption" wrap="truncate-end">
                        {metaOf(row, now)}
                      </Text>
                    </Box>
                    {Svg && row.budgetUsd ? (
                      <Box marginLeft={indent}>
                        <Svg
                          source={budgetSvg(row.costUsd, row.budgetUsd, 480, budgetHex(row), 3)}
                          alt={`${usd(row.costUsd)} of ${usd(row.budgetUsd)} budget`}
                          height={3}
                        />
                      </Box>
                    ) : null}
                  </Box>
                );
              };
              // A pull request with one run needs no group row: one line, the pull request beside the agent.
              if (group.rows.length === 1 && group.key !== "other") {
                return (
                  <Box key={`group-${group.key}`} flexDirection="column" marginTop={1} {...GROUP_BOX}>
                    {runLine(group.rows[0], true)}
                  </Box>
                );
              }
              return (
                <Box key={`group-${group.key}`} flexDirection="column" marginTop={1} {...GROUP_BOX}>
                  {/* One line: a bar in the group's state colour, its name (which folds it), its link, its state. */}
                  <Box alignItems="center">
                    <Text color={groupColor(group)} bold>
                      ▍
                    </Text>
                    <Box flexGrow={1}>
                      <Markdown
                        key={`toggle-${group.key}`}
                        text={`**[${isOpen ? "▼" : "▶"}  ${clean(group.label)}](${toggleHref})**${group.url ? `  [↗](${group.url})` : ""}  ${groupState(group)}`}
                        pressableLinks={[toggleHref]}
                        onLinkPress={() =>
                          void update($, groupOpen, (current) => ({ ...current, [group.key]: !isOpen }))
                        }
                      />
                    </Box>
                    <Box width={8} justifyContent="flex-end">
                      <Text weight="semibold" tabular>
                        {usd(total)}
                      </Text>
                    </Box>
                  </Box>
                  {isOpen && group.rows.map((entry) => runLine(entry))}
                </Box>
              );
            })}
          </Box>
        )}
        {!isDesktop && (
          <Box flexDirection="column">
            {(() => {
              const entries: ListEntry[] = isFiltered
                ? shown.map((row) => ({ kind: "run" as const, row, depth: 0, event: null }))
                : asChains(shown);
              let runIndex = 0;
              return entries.slice(0, Math.max(4, Math.floor(((e.viewport?.rows ?? 30) - 12) / 2) + 2)).map((entry) => {
                if (entry.kind === "heading") {
                  const name = entry.pr.startsWith("issue:") ? entry.pr.slice("issue:".length) : `PR ${entry.pr}`;
                  return (
                    <Box key={`chain-${entry.pr}`} {...(isDesktop ? { marginTop: 1 } : {})}>
                      {entry.url ? <Link href={entry.url} label={name} /> : <Text bold>{name}</Text>}
                    </Box>
                  );
                }
                const { row, depth, event } = entry;
                // Keys 1-9 open the first nine runs: in the classic terminal the keyboard is the only way in.
                const index = runIndex++;
                const hotkey = index < 9 ? String(index + 1) : undefined;
                const done = row.outcomes.map((o) => o.text).join(" · ");
                return (
                  <Box key={row.id} flexDirection="column">
                    {/* The status pill and the agent, "$x of $y" at the right. */}
                    <Box>
                      <Button
                        key={`run-${row.id}`}
                        {...(hotkey ? { hotkey } : {})}
                        onPress={() => {
                          void update($, selected, () => row.id);
                          void pane.loadDetail(row.id);
                        }}
                      >
                        {hotkey ? <Text dimColor>{hotkey} </Text> : ""}
                        {depth > 0 ? (
                          <Text dimColor>{event ? `${"   ".repeat(depth)}${event} → ` : branch(depth)}</Text>
                        ) : (
                          ""
                        )}
                        {pill(row.status.replaceAll("_", " "), statusTone(row.status), statusMark(row.status))}{" "}
                        <Text bold>{row.agentName}</Text>
                      </Button>
                      <Box flexGrow={1} />
                      <Text tabular {...(budgetShare(row) >= 0.8 ? { color: budgetColor(row) } : { dimColor: true })}>
                        {" "}
                        {costOf(row)}
                      </Text>
                    </Box>
                    {showsLastLine(row) && (
                      // The server's line, as plain text: it is never markdown or a link.
                      <Box key={`last-${row.id}`}>
                        <Text dimColor wrap="truncate-end">
                          {"  "}
                          {"  ".repeat(depth)}↳ {row.lastLine}
                        </Text>
                      </Box>
                    )}
                    {/* The meta line: what started it, the task as one line, how long it ran, what it produced. */}
                    <Box>
                      <Text dimColor wrap="truncate-end">
                        {"  "}
                        {"  ".repeat(depth)}
                        {triggerLabel(row.trigger)}
                        {row.parentRunId ? " (from a lead run)" : ""}
                        {row.task ? " · " : ""}
                      </Text>
                      {row.task && taskUrl(row.task) ? (
                        // One short line: a follow-up task quotes a whole review below its first line.
                        <Link href={taskUrl(row.task) as string} label={taskLine(row.task) ?? row.task.slice(0, 90)} />
                      ) : (
                        row.task && (
                          <Text dimColor wrap="truncate-end">
                            {taskLine(row.task) ?? row.task.slice(0, 90)}
                          </Text>
                        )
                      )}
                      <Text dimColor wrap="truncate-end">
                        {" · "}
                        {took(row, now)}
                        {done ? ` · ${done}` : ""}
                      </Text>
                    </Box>
                  </Box>
                );
              });
            })()}
          </Box>
        )}
      </Box>
    );
  });
};
