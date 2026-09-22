/**
 * Provider seams — the interfaces the core depends on.
 *
 * The core imports only from here; it never references a concrete adapter or a
 * cloud SDK. Adapters live alongside each interface (e.g. `jobs/local.ts`,
 * `jobs/kubernetes.ts`) and are wired up from configuration.
 */

export * from "./jobs/types.js";
export * from "./email/types.js";
export * from "./llm/types.js";
export * from "./secrets/types.js";
export * from "./auth/types.js";
export * from "./storage/types.js";
export * from "./executor/types.js";
export * from "./datastore/types.js";
export * from "./memory/types.js";
export * from "./engine/types.js";
export * from "./vcs/types.js";

import type { JobLauncher } from "./jobs/types.js";
import type { EmailProvider } from "./email/types.js";
import type { LlmProvider } from "./llm/types.js";
import type { SecretCipher } from "./secrets/types.js";
import type { AuthProvider } from "./auth/types.js";
import type { BlobStore } from "./storage/types.js";
import type { Executor } from "./executor/types.js";
import type { Datastore } from "./datastore/types.js";
import type { AgentMemoryStore } from "./memory/types.js";
import type { Engine } from "./engine/types.js";
import type { VcsProvider } from "./vcs/types.js";

/** The full set of providers the core is given at startup. */
export interface ProviderRegistry {
  jobs: JobLauncher;
  email: EmailProvider;
  llm: LlmProvider;
  secrets: SecretCipher;
  auth: AuthProvider;
  storage: BlobStore;
  executor: Executor;
  datastore: Datastore;
  memory: AgentMemoryStore;
  engine: Engine;
  vcs: VcsProvider;
}
