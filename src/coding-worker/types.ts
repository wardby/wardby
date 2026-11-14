import type { CodingAgentOutput, CodingTaskInput } from "../coding/protocol.js";
import type { DebugTracer } from "./debug-trace.js";
import type {
  dependencyCacheBudget,
  dependencyCacheTimeLimit,
  prepareDependencies,
  sealUploadWindow,
} from "./dependency-cache.mjs";
import type { createResultBundle, gitAvailable, resolveHistoryPath } from "./result-bundle.mjs";

/** What the driver uses from the dependency cache module (dependency-cache.mjs); injectable for tests. */
export interface DependencyCacheModule {
  prepareDependencies: typeof prepareDependencies;
  sealUploadWindow: typeof sealUploadWindow;
  dependencyCacheBudget: typeof dependencyCacheBudget;
  dependencyCacheTimeLimit: typeof dependencyCacheTimeLimit;
  BUDGET_MEASURE_TIMEOUT_MS: number;
}

/** What the driver uses from the result bundle module (result-bundle.mjs); injectable for tests. */
export interface ResultBundleModule {
  createResultBundle: typeof createResultBundle;
  gitAvailable: typeof gitAvailable;
  resolveHistoryPath: typeof resolveHistoryPath;
}

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
  /** The run's MCP token, set only when the run has MCP tools: sdk.ts then adds the wardby_mcp server. */
  mcpToken?: string;
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
  /** Tests only: replaces loading the dependency cache module, which happens only when the run asks for it. */
  loadDependencyCache?: () => Promise<DependencyCacheModule>;
  /** The run's MCP token (WARDBY_MCP_TOKEN), set only when the run has MCP tools. */
  mcpToken?: string;
  /** Tests only: replaces loading the result bundle module, which happens only on a run with git history. */
  loadResultBundle?: () => Promise<ResultBundleModule>;
  /** The git the history check and the result bundle run; "git" (on PATH) by default. */
  gitBinary?: string;
  /** Where the extra repositories are (/repos/<name>); "/repos" by default. */
  reposRoot?: string;
  /** One operator log line (a fixed-code JSON object); stderr by default. */
  operatorLog?: (event: Record<string, string>) => void;
}
