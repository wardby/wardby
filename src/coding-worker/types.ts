import type { CodingAgentOutput, CodingTaskInput } from "../coding/protocol.js";
import type { DebugTracer } from "./debug-trace.js";

export type WorkerProgressEvent =
  | { schemaVersion: 1; runId: string; type: "turn_started" }
  | { schemaVersion: 1; runId: string; type: "activity"; kind: string; status: string }
  | { schemaVersion: 1; runId: string; type: "completed"; outcome: CodingAgentOutput["outcome"] };

export interface WorkerEvent {
  type: string;
  item?: { type: string; status?: string; text?: string };
  error?: { message: string };
  message?: string;
}

export interface WorkerThread {
  runStreamed(
    prompt: string,
    options: { outputSchema: unknown; signal: AbortSignal },
  ): Promise<{ events: AsyncIterable<WorkerEvent> }>;
}

export interface WorkerAgentClient {
  startThread(options: {
    model: string;
    sandboxMode: "danger-full-access";
    workingDirectory: string;
    skipGitRepoCheck: true;
    networkAccessEnabled: false;
    webSearchMode: "disabled";
    approvalPolicy: "never";
  }): WorkerThread;
}

export interface WorkerClientConfig {
  proxyBaseUrl: string;
  capability: string;
  developerInstructions: string;
  environment: Record<string, string>;
  /** Codex skills to turn off by name (src/coding-worker/skills.ts): always the built-ins, plus the repo's when repoSkills is off. */
  disabledSkills: string[];
}

export type WorkerClientFactory = (config: WorkerClientConfig) => WorkerAgentClient;

export interface WorkerRunOptions {
  input: CodingTaskInput;
  workspace: string;
  proxyBaseUrl: string;
  capability: string;
  signal: AbortSignal;
  createClient: WorkerClientFactory;
  onProgress?: (event: WorkerProgressEvent) => void;
  /** Set only for a run the operator asked to trace (CodingTaskInput.debugTrace). */
  trace?: DebugTracer;
}
