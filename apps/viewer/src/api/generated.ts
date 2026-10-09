// Generated from src/viewer/schemas by scripts/gen-types.mjs — do not edit.

export interface GraphSnapshot {
  generatedAt: string;
  since: string;
  limit: number;
  truncated: boolean;
  runs: {
    id: string;
    parentRunId: string | null;
    agentId: string;
    agentName: string;
    agentKind: "native" | "coding";
    model: string;
    codingProvider: string | null;
    nativeExecutionMode: ("control-plane" | "sandbox") | null;
    warmWorkerName: string | null;
    status: "pending" | "running" | "succeeded" | "failed" | "refused" | "lost" | "budget_exhausted" | "cancelled";
    trigger:
      | {
          kind: "manual";
        }
      | {
          kind: "scheduled";
          schedule: string | null;
        }
      | {
          kind: "webhook";
        }
      | {
          kind: "subagent";
        }
      | {
          kind: "code_host";
          provider: string;
          repository: string;
          number: number | null;
          event: "review" | "mention";
        }
      | {
          kind: "issue";
          provider: string;
          issueKey: string;
          url: string | null;
        }
      | {
          kind: "host_event";
        };
    turns: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    budgetUsd: number;
    startedAt: string;
    finishedAt: string | null;
    heartbeatAt: string | null;
    outcomes: (
      | {
          kind: "pull_request";
          provider: string;
          repository: string;
          number: number;
          url: string;
          state: string | null;
          at: string | null;
        }
      | {
          kind: "code_host_comment";
          provider: string;
          repository: string;
          number: number;
          at: string | null;
        }
      | {
          kind: "issue_comment";
          provider: string;
          issueKey: string;
          url: string | null;
          at: string | null;
        }
      | {
          kind: "check";
          provider: string;
          repository: string;
          number: number | null;
          completed: boolean;
          at: string | null;
        }
    )[];
    declaredServices: {
      name: string;
      version: string;
    }[];
    services: {
      name: string;
      state: "pending" | "probing" | "ready" | "failed";
      attempts: number | null;
      reason: string | null;
      readyAt: string | null;
      failedAt: string | null;
      createdAt: string;
    }[];
  }[];
  spend: {
    todayUsd: number;
    groups: {
      id: string;
      name: string;
      dailyBudgetUsd: number | null;
      spentTodayUsd: number;
    }[];
  };
}

export interface RunDetail {
  id: string;
  parentRunId: string | null;
  agentId: string;
  agentName: string;
  agentKind: "native" | "coding";
  model: string;
  codingProvider: string | null;
  nativeExecutionMode: ("control-plane" | "sandbox") | null;
  warmWorkerName: string | null;
  status: "pending" | "running" | "succeeded" | "failed" | "refused" | "lost" | "budget_exhausted" | "cancelled";
  trigger:
    | {
        kind: "manual";
      }
    | {
        kind: "scheduled";
        schedule: string | null;
      }
    | {
        kind: "webhook";
      }
    | {
        kind: "subagent";
      }
    | {
        kind: "code_host";
        provider: string;
        repository: string;
        number: number | null;
        event: "review" | "mention";
      }
    | {
        kind: "issue";
        provider: string;
        issueKey: string;
        url: string | null;
      }
    | {
        kind: "host_event";
      };
  turns: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  budgetUsd: number;
  startedAt: string;
  finishedAt: string | null;
  heartbeatAt: string | null;
  outcomes: (
    | {
        kind: "pull_request";
        provider: string;
        repository: string;
        number: number;
        url: string;
        state: string | null;
        at: string | null;
      }
    | {
        kind: "code_host_comment";
        provider: string;
        repository: string;
        number: number;
        at: string | null;
      }
    | {
        kind: "issue_comment";
        provider: string;
        issueKey: string;
        url: string | null;
        at: string | null;
      }
    | {
        kind: "check";
        provider: string;
        repository: string;
        number: number | null;
        completed: boolean;
        at: string | null;
      }
  )[];
  declaredServices: {
    name: string;
    version: string;
  }[];
  services: {
    name: string;
    state: "pending" | "probing" | "ready" | "failed";
    attempts: number | null;
    reason: string | null;
    readyAt: string | null;
    failedAt: string | null;
    createdAt: string;
  }[];
  error: string | null;
  finalText: string | null;
  childRunIds: string[];
  coding: {
    provider: string;
    repository: string;
    baseRef: string;
    headRef: string;
    queuedAt: string | null;
    failureCategory: string | null;
    services: {
      name: string;
      version: string;
      image: string;
      envNames: string[];
    }[];
  } | null;
}

export type ViewerEvent =
  | {
      kind: "run";
      runId: string;
      parentRunId: string | null;
      agentId: string;
      status: "pending" | "running" | "succeeded" | "failed" | "refused" | "lost" | "budget_exhausted" | "cancelled";
      turns: number;
      tokensIn: number;
      tokensOut: number;
      costUsd: number;
      finishedAt: string | null;
    }
  | {
      kind: "service";
      runId: string;
      name: string;
      state: "pending" | "probing" | "ready" | "failed";
      attempts: number | null;
    }
  | {
      kind: "outcome";
      runId: string;
      source: "pull_request" | "host_status" | "issue_status" | "host_check";
    };

export interface InfraInfo {
  launcher: "local" | "docker" | "kubernetes";
  kubernetes: {
    namespace: string;
    platform: string;
    runtimeClass: string | null;
    proxyService: string;
    runLabel: string;
    runLabelHashChars: number;
    componentLabel: {
      [k: string]: string | undefined;
    };
    managedByLabel: {
      [k: string]: string | undefined;
    };
  } | null;
  native: {
    launcher: "docker" | "kubernetes";
    warmPoolSize: number;
    kubernetes: {
      namespace: string;
      runtimeClass: string | null;
      runLabel: string;
      componentLabel: {
        [k: string]: string | undefined;
      };
      warmPoolLabel: {
        [k: string]: string | undefined;
      };
      warmWorkerLabel: string;
    } | null;
  } | null;
}
