import { atom, read, update } from "claude-code";
import type { Register } from "claude-code";

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
const detail = atom({ plugin: "wardby-runs", key: "detail" } as const, null, { shape: "detail-2" });
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
 * was started by a pull request, or opened one, sits under that pull request in the order it started,
 * the event that started it (review, mention) beside it. Trees that touch no pull request stand alone.
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
    const sorted = [...unit.trees].sort((a, b) => Date.parse(a[0].row.startedAt) - Date.parse(b[0].row.startedAt));
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
 * pull request's group, in the order it ran, with its sub-agent runs under their lead; the rest go to
 * "other". Groups are ordered by their newest run, "other" last.
 */
function asLedger(rows: RunRow[]): LedgerGroup[] {
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
    .sort((a, b) => (a.key === "other" ? 1 : b.key === "other" ? -1 : b.newest - a.newest))
    .map((group) => ({
      key: group.key,
      label: group.label,
      url: group.url,
      rows: [...group.trees]
        .sort((a, b) => Date.parse(a[0].row.startedAt) - Date.parse(b[0].row.startedAt))
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
        return [{ kind: "comment", text: `commented on ${String(outcome.issueKey)}`, url: str(outcome.url), pr: null }];
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

/** The seqs of steps that have detail, in order. */
const detailSeqs = (steps: Step[]): number[] => steps.filter((s) => s.detail !== null).map((s) => s.seq);

/** The cursor moved by `delta` among `seqs` (from the first or last when there is none). */
function moveCursor(current: OpenStep | null, runId: string, seqs: number[], delta: 1 | -1): OpenStep | null {
  if (seqs.length === 0) return current;
  const at = current?.runId === runId ? seqs.indexOf(current.seq) : -1;
  const next = at < 0 ? (delta > 0 ? 0 : seqs.length - 1) : Math.min(seqs.length - 1, Math.max(0, at + delta));
  // An expanded step stays expanded as the cursor moves: the detail follows the cursor.
  return { runId, seq: seqs[next], open: current?.runId === runId && current.open };
}

/** A step as one line, worded as the server's lastStep.line: "Bash: npm test (exit 1)", "said: …". */
function stepLine(step: Step): string {
  const head = step.kind === "tool" ? `${step.tool ?? "tool"}: ${step.summary}` : `said: ${step.summary}`;
  return step.status && step.status !== "ok" ? `${head} (${step.status})` : head;
}

/** A step's mark: › said, … a tool still running, ✓ ok, ✗ error or a non-zero exit (the only coloured one). */
function stepMark(step: Step): { mark: string; failed: boolean } {
  if (step.kind !== "tool") return { mark: "›", failed: false };
  if (step.status === null) return { mark: "…", failed: false };
  return step.status === "ok" ? { mark: "✓", failed: false } : { mark: "✗", failed: true };
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

function badge(status: string): { icon: string; color: string } {
  if (status === "running") return { icon: "●", color: "suggestion" };
  if (status === "pending") return { icon: "○", color: "inactive" };
  if (status === "succeeded") return { icon: "✓", color: "success" };
  return { icon: "✗", color: "error" };
}

// The desktop palette: colour carries a run's status, and nothing else is coloured.
// Text colours are the theme's own names, so they follow light and dark mode.
const STATUS_COLOR: Record<string, string> = { running: "suggestion", succeeded: "success", pending: "inactive" };
const FAILED_COLOR = "error";
const WARN_COLOR = "warning";
const HEADING_COLOR = "subtle";
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

/** A run in one plain sentence: what started it, how long it ran, and when it was last active. */
function runSentence(row: RunRow, now: number): string {
  const start: Record<string, string> = {
    manual: "Started by hand",
    scheduled: "Started on its schedule",
    webhook: "Started by a webhook",
    subagent: "Started by a lead run",
    host_event: "Started by a GitHub or Jira event",
  };
  const ran = ACTIVE.has(row.status)
    ? `Running for ${took(row, now)}, ${row.turns} ${row.turns === 1 ? "turn" : "turns"} so far`
    : `Ran ${took(row, now)} over ${row.turns} ${row.turns === 1 ? "turn" : "turns"}`;
  const last = row.heartbeatAt ? `, last active ${ago(row.heartbeatAt, now)} ago` : "";
  return `${start[row.trigger] ?? "Started"}. ${ran}${last}.`;
}
const statusColor = (status: string): string => STATUS_COLOR[status] ?? FAILED_COLOR;
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
function budgetSvg(cost: number, budget: number, widthPx: number, fill: string): string {
  const share = Math.max(0, Math.min(1, cost / budget));
  const filled = share > 0 ? Math.max(3, Math.round(share * widthPx)) : 0;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="6" viewBox="0 0 ${widthPx} 6">` +
    `<rect width="${widthPx}" height="6" rx="3" fill="${SVG_TRACK}" />` +
    `<rect width="${filled}" height="6" rx="3" fill="${fill}" /></svg>`
  );
}

/** Markdown cut to about `max` characters at a line break, so a list or a paragraph isn't cut mid-word. */
function cutMarkdown(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return `${text.slice(0, cut > max / 2 ? cut : max).trimEnd()}\n\n…`;
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
      const D = e.surface === "desktop";
      // Keys are for the terminal, where the keyboard is the way in; the desktop takes clicks.
      const hk = (key: string) => (D ? {} : { hotkey: key });
      // Section headings: small, sentence case, one quiet colour.
      const heading = (text: string) =>
        D ? (
          <Text weight="semibold" size="caption" color={HEADING_COLOR}>
            {text}
          </Text>
        ) : (
          <Text dimColor bold>
            {text}
          </Text>
        );
      // Long text: the whole of it, wrapped, when expanded; else one line cut at the edge.
      const long = (text: string) =>
        isFull ? <Text wrap="wrap">{text}</Text> : <Text wrap="truncate-end">{text.slice(0, 400)}</Text>;
      // Text written as markdown (the request, the run's final answer): drawn as markdown, whole when expanded.
      const prose = (key: string, text: string) =>
        Markdown ? <Markdown key={key} text={isFull ? text : cutMarkdown(text, 700)} /> : long(text);
      const hasLong = [
        open.task,
        info?.id === open.id ? info.request : null,
        info?.id === open.id ? info.finalText : null,
      ].some((text) => (text ?? "").length > 60);
      const shown = info && info.id === open.id ? info : null;
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
        return (
          <Box flexDirection="column">
            {heading(isRecent ? "Recent steps" : "Steps")}
            {stepsOf.steps.map((step) => {
              const { mark, failed } = stepMark(step);
              const hasDetail = step.detail !== null;
              const isCursor = cursor?.runId === open.id && cursor.seq === step.seq;
              const isOpen = hasDetail && isCursor && cursor.open;
              const line = (
                <Text wrap="wrap">
                  {!D && isCursor ? "› " : ""}
                  <Text {...(failed ? { color: FAILED_COLOR } : { dimColor: true })}>{mark}</Text> {stepLine(step)}
                  {hasDetail ? (isOpen ? " ▾" : " ▸") : ""}
                </Text>
              );
              return (
                <Box key={`step-${step.seq}`} flexDirection="column">
                  {hasDetail ? (
                    <Button
                      key={`step-detail-${step.seq}`}
                      onPress={() =>
                        void update($, openStep, (current): OpenStep => ({
                          runId: open.id,
                          seq: step.seq,
                          open: !(current?.runId === open.id && current.seq === step.seq && current.open),
                        }))
                      }
                    >
                      {line}
                    </Button>
                  ) : (
                    line
                  )}
                  {isOpen &&
                    step.detail !== null &&
                    (() => {
                      // Stored already redacted; plain text only: a detail never becomes markdown or a link.
                      // Its last lines only, so one step cannot push the pane off the screen.
                      const { text, hidden } = detailTail(step.detail);
                      return (
                        <Box key={`step-text-${step.seq}`} flexDirection="column" paddingLeft={2}>
                          {hidden > 0 && (
                            <Text dimColor>
                              … {hidden} more {hidden === 1 ? "line" : "lines"}
                            </Text>
                          )}
                          <Text dimColor wrap="wrap">
                            {text}
                          </Text>
                        </Box>
                      );
                    })()}
                </Box>
              );
            })}
            {!D && detailSeqs(stepsOf.steps).length > 0 && (
              <Box gap={2}>
                <Button
                  key="step-prev"
                  label="Previous (k)"
                  hotkey="k"
                  onPress={() => void update($, openStep, (c) => moveCursor(c, open.id, detailSeqs(stepsOf.steps), -1))}
                />
                <Button
                  key="step-next"
                  label="Next (j)"
                  hotkey="j"
                  onPress={() => void update($, openStep, (c) => moveCursor(c, open.id, detailSeqs(stepsOf.steps), 1))}
                />
                <Button
                  key="step-open"
                  label="Show detail (e)"
                  hotkey="e"
                  onPress={() =>
                    void update($, openStep, (c) => {
                      const seqs = detailSeqs(stepsOf.steps);
                      const at = c?.runId === open.id && seqs.includes(c.seq) ? c : moveCursor(null, open.id, seqs, -1);
                      return at ? { ...at, open: !at.open } : c;
                    })
                  }
                />
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
          </Box>
        );
      })();
      const prOutcome = open.outcomes.find((o) => o.kind === "pull_request" && o.url);
      const prUrl = shown?.pullRequestUrl ?? prOutcome?.url ?? null;
      const prNumber = prUrl ? /\/pull\/(\d+)/.exec(prUrl)?.[1] : null;
      return (
        <Box flexDirection="column" gap={1}>
          <Box>
            <Button
              key="back"
              label="‹ Runs"
              {...hk("b")}
              onPress={() => {
                void update($, selected, () => null);
                void update($, openStep, () => null);
              }}
            />
          </Box>
          <Box flexDirection="column">
            <Box gap={1} alignItems="center">
              <Text size="heading" weight="semibold" bold={!D}>
                {open.agentName}
              </Text>
              <Text color={statusColor(open.status)} weight="semibold" bold={!D}>
                {statusMark(open.status)} {open.status.replaceAll("_", " ")}
              </Text>
            </Box>
            <Text dimColor size="caption">
              {runSentence(open, now)}
            </Text>
          </Box>
          {D && open.budgetUsd && Svg ? (
            <Box gap={1} alignItems="center">
              <Svg
                source={budgetSvg(open.costUsd, open.budgetUsd, 200, budgetHex(open))}
                alt={`${usd(open.costUsd)} of ${usd(open.budgetUsd)} budget`}
                width={200}
                height={6}
              />
              <Text
                size="caption"
                tabular
                {...(budgetShare(open) >= 0.8 ? { color: budgetColor(open) } : { dimColor: true })}
              >
                {usd(open.costUsd)} of {usd(open.budgetUsd)}
              </Text>
            </Box>
          ) : (
            <Text>
              {bar(open.costUsd, open.budgetUsd, 20)} {usd(open.costUsd)}
              {open.budgetUsd ? ` of ${usd(open.budgetUsd)}` : ""}
            </Text>
          )}
          {/* Actions: the pull request first, then quiet ones. */}
          <Box gap={2} alignItems="center" flexWrap="wrap">
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
          </Box>
          {shown && (shown.error || shown.failureCategory) && (
            // An error reads first, in a pale red box: what failed, then the plain message.
            <Box
              flexDirection="column"
              {...(D ? { borderStyle: "round", borderColor: FAILED_COLOR, paddingX: 1 } : {})}
            >
              <Text color={FAILED_COLOR} weight="semibold" bold>
                {shown.failureCategory ? shown.failureCategory.replaceAll("_", " ") : "Failed"}
              </Text>
              {shown.error && <Text wrap="wrap">{shown.error}</Text>}
            </Box>
          )}
          {stepsOf?.mode === "recent" && stepsBlock}
          {open.via && (
            <Box flexDirection="column">
              {heading("Started by")}
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
            </Box>
          )}
          {(open.outcomes.length > 0 || (shown && (shown.pullRequestUrl || shown.resultBranch || shown.outcome))) && (
            <Box flexDirection="column">
              {heading("What it produced")}
              {open.outcomes.map((outcome, i) =>
                outcome.url ? (
                  <Link
                    key={`outcome-${i}`}
                    href={outcome.url}
                    label={`${outcome.text.replace(/^opened /, "Opened ")}${outcome.pr ? ` in ${outcome.pr.replace(/#\d+$/, "")}` : ""}`}
                  />
                ) : (
                  <Text key={`outcome-${i}`}>{outcome.text.charAt(0).toUpperCase() + outcome.text.slice(1)}</Text>
                ),
              )}
              {open.outcomes.length === 0 && shown?.pullRequestUrl && (
                <Link
                  href={shown.pullRequestUrl}
                  label={`Pull request${prNumber ? ` #${prNumber}` : ""}${shown.repository ? ` in ${shown.repository}` : ""}`}
                />
              )}
              {!shown?.pullRequestUrl && shown?.resultBranch && <Text>Pushed branch {shown.resultBranch}</Text>}
              {shown?.outcome && !shown.pullRequestUrl && !shown.resultBranch && (
                <Text dimColor>{shown.outcome.replaceAll("_", " ")}</Text>
              )}
            </Box>
          )}
          {!shown && <Text dimColor>Loading details…</Text>}
          {open.task && !shown?.request && (
            <Box flexDirection="column">
              {heading("Task")}
              {long(open.task)}
            </Box>
          )}
          {shown?.request && (
            <Box flexDirection="column">
              {heading("Request")}
              {prose("request-text", shown.request)}
            </Box>
          )}
          {shown && shown.services.length > 0 && (
            <Box flexDirection="column">
              {heading("Services")}
              <Text>{shown.services.join(", ")}</Text>
            </Box>
          )}
          {shown?.finalText && (
            <Box flexDirection="column">
              {heading("Final answer")}
              {prose("final-text", shown.finalText)}
            </Box>
          )}
          {stepsOf?.mode === "all" && stepsBlock}
          {shown && !ACTIVE.has(open.status) && (shown.outcome || shown.resultBranch) && Input && (
            <Box flexDirection="column">
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
                          onPress={(press) => void $.ui.copy({ text: state.command as string, surface: press.surface })}
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
            </Box>
          )}
          {(() => {
            const tree = treeOf(rows, open.id);
            if (tree.length < 2) return null;
            return (
              <Box flexDirection="column">
                {heading("Run tree")}
                {tree.map(({ row, depth }) => {
                  const markColor = statusColor(row.status);
                  return row.id === open.id ? (
                    <Text key={`tree-${row.id}`} bold>
                      {branch(depth)}
                      {statusMark(row.status)} {row.agentName} (this run) {usd(row.costUsd)}, {took(row, now)}
                    </Text>
                  ) : (
                    <Button
                      key={`tree-${row.id}`}
                      onPress={() => {
                        void update($, selected, () => row.id);
                        void pane.loadDetail(row.id);
                      }}
                    >
                      <Text dimColor>{branch(depth)}</Text>
                      <Text color={markColor}>{statusMark(row.status)}</Text> {row.agentName}{" "}
                      <Text dimColor>
                        {usd(row.costUsd)}, {took(row, now)}
                      </Text>
                    </Button>
                  );
                })}
              </Box>
            );
          })()}
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
      );
    }

    const active = rows.filter((row) => ACTIVE.has(row.status)).length;
    // The desktop draws the mockup's cards, chips, tiles and SVG bars; the terminal keeps text rows.
    const isDesktop = e.surface === "desktop";
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
              const groups = asLedger(shown);
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
            <Box>
              <Box width={2} />
              <Text dimColor size="caption">
                Run
              </Text>
              <Box flexGrow={1} />
              <Box width={8} justifyContent="flex-end">
                <Text dimColor size="caption">
                  Time
                </Text>
              </Box>
              <Box width={8} justifyContent="flex-end">
                <Text dimColor size="caption">
                  Cost
                </Text>
              </Box>
            </Box>
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
                const failed = !ACTIVE.has(row.status) && row.status !== "succeeded";
                const pr =
                  withPr && group.url
                    ? `  [${clean(group.label)} ↗](${group.url})`
                    : withPr
                      ? `  ${clean(group.label)}`
                      : "";
                return (
                  <Box key={row.id} flexDirection="column">
                    <Box>
                      <Box width={2}>
                        <Text color={statusColor(row.status)} weight="semibold">
                          {statusMark(row.status)}
                        </Text>
                      </Box>
                      <Box flexGrow={1} marginLeft={depth > 0 ? 3 : 1}>
                        <Markdown
                          key={`run-${row.id}`}
                          text={`${label ? `${label}  ` : ""}${openId === row.id ? "**" : ""}[${clean(row.agentName)}](${runHref(row.id)})${openId === row.id ? "**" : ""}${pr}${failed ? `  ${row.status.replaceAll("_", " ")}` : ""}`}
                          pressableLinks={[runHref(row.id)]}
                          onLinkPress={() => {
                            void update($, selected, () => row.id);
                            void pane.loadDetail(row.id);
                          }}
                        />
                      </Box>
                      <Box width={8} justifyContent="flex-end">
                        <Text
                          tabular
                          size="caption"
                          {...(ACTIVE.has(row.status) ? { color: statusColor(row.status) } : { dimColor: true })}
                        >
                          {took(row, now)}
                        </Text>
                      </Box>
                      <Box width={8} justifyContent="flex-end">
                        <Text
                          tabular
                          size="caption"
                          {...(budgetShare(row) >= 0.8 ? { color: budgetColor(row) } : { dimColor: true })}
                        >
                          {usd(row.costUsd)}
                        </Text>
                      </Box>
                    </Box>
                    {showsLastLine(row) && (
                      <Box key={`last-${row.id}`} marginLeft={depth > 0 ? 5 : 3}>
                        <Text dimColor size="caption" wrap="truncate-end">
                          {row.lastLine}
                        </Text>
                      </Box>
                    )}
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
                const { icon, color } = badge(row.status);
                // Keys 1-9 open the first nine runs: in the classic terminal the keyboard is the only way in.
                const index = runIndex++;
                const hotkey = index < 9 ? String(index + 1) : undefined;
                const done = row.outcomes.map((o) => o.text).join(" · ");
                return (
                  <Box key={row.id} flexDirection="column">
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
                      <Text color={color}>{icon}</Text> {row.agentName} <Text dimColor>{row.status}</Text>
                    </Button>
                    {showsLastLine(row) && (
                      // The server's line, as plain text: it is never markdown or a link.
                      <Box key={`last-${row.id}`}>
                        <Text dimColor wrap="truncate-end">
                          {"  "}
                          {"  ".repeat(depth)}↳ {row.lastLine}
                        </Text>
                      </Box>
                    )}
                    <Box>
                      <Text dimColor wrap="truncate-end">
                        {"  "}
                        {"  ".repeat(depth)}
                        {triggerLabel(row.trigger)}
                        {row.parentRunId ? " (from a lead run)" : ""}
                        {row.task ? " · " : ""}
                      </Text>
                      {row.task && taskUrl(row.task) ? (
                        <Link href={taskUrl(row.task) as string} label={row.task} />
                      ) : (
                        row.task && (
                          <Text dimColor wrap="truncate-end">
                            {row.task}
                          </Text>
                        )
                      )}
                    </Box>
                    <Text dimColor wrap="truncate-end">
                      {"  "}
                      {took(row, now)} · {usd(row.costUsd)}
                      {row.budgetUsd ? ` of ${usd(row.budgetUsd)}` : ""}{" "}
                      {ACTIVE.has(row.status) ? bar(row.costUsd, row.budgetUsd, Math.min(12, width - 30)) : ""}
                      {done ? ` · ${done}` : ""}
                    </Text>
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
