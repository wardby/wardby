/**
 * Deterministic Slack text for workflow notifications. Pure functions: no
 * I/O, no model output. Every string that came from a person or a model
 * (titles, agent names, reasons) is escaped so it cannot become a link or a
 * mention; only canonical tracker/host URLs are formatted as links.
 */
import type { ThreadSubject, WorkflowPayload } from "./workflow-events.js";

export type ThreadStatus =
  | "picked up"
  | "PR open"
  | "changes requested"
  | "fixing"
  | "fix rounds exhausted"
  | "approved"
  | "merged ✅"
  | "closed"
  | "failed ❌";

const TERMINAL: ReadonlySet<ThreadStatus> = new Set(["merged ✅", "closed"]);
/** Events that start a new attempt (a new pickup, a new PR) and so reopen a merged/closed thread. */
const REOPENS: ReadonlySet<WorkflowPayload["kind"]> = new Set(["issue_picked_up", "pr_opened"]);

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A URL is only linked when it is https; the label is escaped. */
function link(url: string | null, label: string): string {
  const safe = escapeMrkdwn(label);
  return url && url.startsWith("https://") && !/[<>|\s]/.test(url) ? `<${url}|${safe}>` : safe;
}

export function nextStatus(prev: ThreadStatus | null, p: WorkflowPayload): ThreadStatus {
  const terminal = prev !== null && TERMINAL.has(prev);
  if (terminal && !REOPENS.has(p.kind)) return prev;
  switch (p.kind) {
    case "issue_picked_up":
      return terminal ? "picked up" : (prev ?? "picked up");
    case "pr_opened":
      return "PR open";
    case "review_posted":
      if (p.verdict === "APPROVE") return "approved";
      if (p.verdict === "CHANGES_REQUESTED") return "changes requested";
      return prev ?? "PR open";
    case "review_fix":
      return p.state === "started" ? "fixing" : "fix rounds exhausted";
    case "pr_closed":
      return p.merged ? "merged ✅" : "closed";
    case "run_failed":
      return "failed ❌";
  }
}

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });

export function renderParent(subject: ThreadSubject, status: ThreadStatus): { text: string; blocks: unknown[] } {
  const head = link(subject.url, subject.label) + (subject.title ? ` · ${escapeMrkdwn(subject.title)}` : "");
  const text = `${head} — *${status}*`;
  return { text, blocks: [section(text)] };
}

export function renderEvent(p: WorkflowPayload, spend: string | null): { text: string; blocks: unknown[] } {
  let line: string;
  switch (p.kind) {
    case "issue_picked_up":
      line = `🟢 Picked up by *${escapeMrkdwn(p.agentName)}* (${escapeMrkdwn(p.trigger)})`;
      break;
    case "pr_opened":
      line = `🔀 PR ${link(p.prUrl, p.prLabel)} is ready${p.movedTo ? ` — moved to ${escapeMrkdwn(p.movedTo)}` : ""}`;
      break;
    case "review_posted": {
      const who = `*${escapeMrkdwn(p.agentName)}*`;
      const target = link(p.prUrl, p.prLabel);
      line =
        p.verdict === "APPROVE"
          ? `✅ ${who} approved ${target}`
          : p.verdict === "CHANGES_REQUESTED"
            ? `📝 ${who} requested changes on ${target}`
            : `💬 ${who} commented on ${target}${p.ciPending ? " (CI still running)" : ""}`;
      break;
    }
    case "review_fix":
      line =
        p.state === "started"
          ? `🔁 Fix round ${p.round} of ${p.maxRounds} started on ${escapeMrkdwn(p.prLabel)}`
          : `🛑 Still changes requested after ${p.maxRounds} fix rounds on ${escapeMrkdwn(p.prLabel)} — needs a person`;
      break;
    case "pr_closed":
      line = p.merged
        ? `🎉 ${link(p.prUrl, p.prLabel)} merged${p.movedTo ? ` — moved to ${escapeMrkdwn(p.movedTo)}` : ""}`
        : `⚪ ${link(p.prUrl, p.prLabel)} closed without merging`;
      break;
    case "run_failed": {
      const who = `*${escapeMrkdwn(p.agentName)}*`;
      line =
        p.status === "budget_exhausted"
          ? `❌ ${who} stopped: budget exhausted`
          : p.status === "lost"
            ? `❌ ${who} was lost (no heartbeat)`
            : p.status === "cancelled"
              ? `❌ ${who} was cancelled`
              : `❌ ${who} ${p.status === "refused" ? "was refused" : "failed"}${p.reason ? `: ${escapeMrkdwn(p.reason)}` : ""}`;
      break;
    }
  }
  const text = spend ? `${line}\n_${escapeMrkdwn(spend)}_` : line;
  return { text, blocks: [section(text)] };
}

/**
 * The Slack display name for a message about this event: the agent's name
 * when the event names one, otherwise "wardby". Only takes effect when
 * WARDBY_SLACK_CUSTOMIZE is on (chat:write.customize); no icon is set.
 */
export function senderName(p: WorkflowPayload): string {
  switch (p.kind) {
    case "issue_picked_up":
    case "run_failed":
    case "review_posted":
      return p.agentName;
    default:
      return "wardby";
  }
}

export function broadcasts(p: WorkflowPayload): boolean {
  return (p.kind === "pr_closed" && p.merged) || p.kind === "run_failed";
}
