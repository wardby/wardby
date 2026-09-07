import { Codex } from "@openai/codex-sdk";
import type { WorkerClientConfig, WorkerClientFactory } from "./types.js";

export function codexSdkOptions(config: WorkerClientConfig) {
  return {
    apiKey: config.capability,
    env: config.environment,
    config: {
      developer_instructions: config.developerInstructions,
      shell_environment_policy: {
        inherit: "none",
        ignore_default_excludes: false,
        set: config.environment,
      },
      model_provider: "reevo_proxy",
      model_providers: {
        reevo_proxy: {
          name: "Reevo per-run proxy",
          base_url: `${config.proxyBaseUrl.replace(/\/$/, "")}/v1`,
          env_key: "CODEX_API_KEY",
          wire_api: "responses",
          request_max_retries: 0,
          stream_max_retries: 0,
          supports_websockets: false,
        },
      },
    },
  } as const;
}

export const createCodexSdkClient: WorkerClientFactory = (config) => new Codex(codexSdkOptions(config));
