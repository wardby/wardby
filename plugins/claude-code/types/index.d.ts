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

/** The long text fields get_run may send as a first page, the rest through get_run_text (servers with get_run_text). */
export type TextField = "request" | "taskOverride" | "finalText" | "error";

export type RunDetail = {
  id: string;
  request: string | null;
  /** get_run's taskOverride: the task a trigger or lead gave the run. */
  task: string | null;
  /**
   * Fields get_run sent only the first page of (its <field>More): where the rest starts and the whole
   * length. Empty from an older server, which sends every field whole.
   */
  more: Partial<Record<TextField, { next: number; total: number }>>;
  finalText: string | null;
  error: string | null;
  failureCategory: string | null;
  outcome: string | null;
  repository: string | null;
  pullRequestUrl: string | null;
  resultBranch: string | null;
  services: string[];
  /** Each service's start-up state by name (pending, probing, ready, failed), from serviceReadiness. */
  serviceStates: Record<string, string>;
  /** The model the run was billed at (pricingSnapshot.modelId); null when the server didn't record one. */
  model: string | null;
  parentRunId: string | null;
  /** The newest step's seq from get_run's lastStep (wardby 0.9.0+); null without one. */
  lastStepSeq: number | null;
};

export type Step = {
  seq: number;
  at: string;
  kind: string;
  tool: string | null;
  summary: string;
  status: string | null;
  /** The step's detail text (wardby 0.9.0+, detail level, owner and starter only); null otherwise. */
  detail: string | null;
};

/** The step whose detail is shown (one at a time), and the terminal's cursor among steps with detail. */
export type OpenStep = { runId: string; seq: number; open: boolean };

export type Steps = {
  runId: string;
  /** recent: a running run's last few, read again each poll; all: a finished run's, page by page. */
  mode: "recent" | "all";
  /** The server's level: "off" records none; null when the server didn't say. */
  level: string | null;
  steps: Step[];
  /** The `after` for the next page (mode "all"), or null when there is none. */
  next: number | null;
  dropped: number;
  /** The run's steps were deleted after the retention period. */
  expired: boolean;
  /** A fixed hint shown instead of steps (auto mode refused get_run_steps). */
  notice: string | null;
};

export type Poll = {
  at: number;
  error: string | null;
  /** The server is older than 0.8.0 (no list_runs without an agentId): the pane runs in a limited mode. */
  limited?: boolean;
};

export type Resume = {
  runId: string;
  dir: string;
  /** missing: no folder at `dir`; `clones` and `cloneUrl` say what the pane can offer instead. */
  phase: "idle" | "running" | "done" | "error" | "missing" | "cloning";
  /** What the import printed, with the download link cut out. */
  output: string;
  /** The claude command it printed, if any. */
  command: string | null;
  /** Folders near this one whose git remote is the run's repository (phase missing). */
  clones?: string[];
  /** Where the repository can be cloned from, when the run's pull request names its host (phase missing). */
  cloneUrl?: string | null;
  /**
   * What the import said to remove later (its "To remove the import later" line), shown as commands: the
   * session folder, and the worktree when the import created it (null when it reused one or used the folder).
   */
  cleanup?: { session: string; worktree: string | null } | null;
};

export type Filter = { status: "all" | "active" | "failed" | "done"; text: string };

/**
 * Runs the server found for the filter text (list_runs' query, wardby 0.9.7+), at any date: `text` is the
 * query they answer, `next` the cursor for the next page (null at the end).
 */
export type Older = {
  text: string;
  rows: RunRow[];
  next: string | null;
  state: "idle" | "loading" | "done" | "error" | "unsupported";
  error: string | null;
};

declare module "claude-code" {
  interface PluginState {
    "wardby-runs": {
      runs: Shaped<RunRow[]>;
      selected: string | null;
      detail: Shaped<RunDetail | null>;
      steps: Shaped<Steps | null>;
      openStep: Shaped<OpenStep | null>;
      poll: Shaped<Poll>;
      filter: Shaped<Filter>;
      older: Shaped<Older>;
      resume: Shaped<Resume | null>;
      expanded: string | null;
      groupOpen: Shaped<Record<string, boolean>>;
      view: "ledger" | "strips";
      picked: Shaped<Record<string, string>>;
    };
  }
}
