export type RunRow = {
  id: string;
  agentId: string;
  agentName: string;
  status: string;
  trigger: string;
  costUsd: number;
  budgetUsd: number | null;
  startedAt: string;
  finishedAt: string | null;
  heartbeatAt: string | null;
  turns: number;
  task: string | null;
  parentRunId: string | null;
  /** The pull request (or issue) and event that started the run, when the server says (wardby 0.8.0+). */
  via: { pr: string; url: string | null; event: string } | null;
  /** What the run produced (wardby 0.8.0+): opened a pull request, commented, a check. */
  outcomes: { kind: string; text: string; url: string | null; pr: string | null }[];
  /** The run's newest step as one line ("Bash: npm test"), from cross-agent list_runs (wardby 0.9.0+); null otherwise. */
  lastLine: string | null;
};

export type RunDetail = {
  id: string;
  request: string | null;
  finalText: string | null;
  error: string | null;
  failureCategory: string | null;
  outcome: string | null;
  repository: string | null;
  pullRequestUrl: string | null;
  resultBranch: string | null;
  services: string[];
  parentRunId: string | null;
};

export type Poll = { at: number; error: string | null };

export type Resume = {
  runId: string;
  dir: string;
  phase: "idle" | "running" | "done" | "error";
  /** What the import printed, with the download link cut out. */
  output: string;
  /** The claude command it printed, if any. */
  command: string | null;
};

export type Filter = { status: "all" | "active" | "failed" | "done"; text: string };

declare module "claude-code" {
  interface PluginState {
    "wardby-runs": {
      runs: Shaped<RunRow[]>;
      selected: string | null;
      detail: Shaped<RunDetail | null>;
      poll: Shaped<Poll>;
      filter: Shaped<Filter>;
      resume: Shaped<Resume | null>;
      expanded: string | null;
      groupOpen: Shaped<Record<string, boolean>>;
      view: "ledger" | "strips";
      picked: Shaped<Record<string, string>>;
    };
  }
}
