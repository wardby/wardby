import type { CodingAgentOutput, CodingTaskInput } from "../coding/protocol.js";

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
}
