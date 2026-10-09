import type { GraphRun, Outcome } from "../api/types";
import { tailTruncate } from "./sizes";

export function triggerLabel(trigger: GraphRun["trigger"]): string {
  switch (trigger.kind) {
    case "scheduled":
      return `⏰ ${trigger.schedule ?? "scheduled"}`;
    case "webhook":
      return "webhook";
    case "manual":
      return "manual";
    case "issue":
      return `◆ ${trigger.provider} ${trigger.issueKey}`;
    case "code_host":
      return `⎇ ${trigger.repository}${trigger.number === null ? "" : `#${trigger.number}`} ${trigger.event}`;
    case "host_event":
      return "host event";
    case "subagent":
      return "sub-agent";
  }
}

/** Searchable text of an outcome: its repository or issue key. */
export function outcomeTerms(o: Outcome): string[] {
  return "repository" in o ? [o.repository] : [o.issueKey];
}

/** A model id short enough for a node: drops the `claude-` prefix and a trailing date stamp. */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

const CODING_BADGES: Record<string, { text: string; name: string }> = {
  codex: { text: "CX", name: "Codex" },
  "claude-code": { text: "CC", name: "Claude Code" },
};

/** The tag marking a sandbox-mode native run, on the Runs graph and the Infrastructure Map alike. */
export const SANDBOX_BADGE = { text: "SB", name: "Agent sandbox: this run executed in its own isolated container" };

/** The small tag naming a coding run's worker; an unknown provider gets its first two letters. */
export function codingBadge(provider: string): { text: string; name: string; known: boolean } {
  const known = CODING_BADGES[provider];
  return known ? { ...known, known: true } : { text: provider.slice(0, 2).toUpperCase(), name: provider, known: false };
}

/** "owner/repo#12" → "repo#12", cut from the front to `max` so the number stays visible. */
export function compactTarget(repository: string, number: number | null, max: number): string {
  const name = repository.slice(repository.lastIndexOf("/") + 1);
  return tailTruncate(number === null ? name : `${name}#${number}`, max);
}

/** A trigger node's short title: a pull request or mention keeps its number; others use the label as is. */
export function triggerTitle(trigger: GraphRun["trigger"], label: string, max: number): string {
  return trigger.kind === "code_host" ? `⎇ ${compactTarget(trigger.repository, trigger.number, max - 2)}` : label;
}
