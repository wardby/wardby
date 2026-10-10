import { Codex } from "@openai/codex-sdk";
import type { WorkerClientConfig, WorkerClientFactory } from "./types.js";

export function codexSdkOptions(config: WorkerClientConfig) {
  return {
    apiKey: config.capability,
    env: config.environment,
    config: {
      developer_instructions: config.developerInstructions,
      skills: { config: config.disabledSkills.map((name) => ({ name, enabled: false })) },
      shell_environment_policy: {
        inherit: "none",
        ignore_default_excludes: false,
        set: config.environment,
      },
      model_provider: "wardby_proxy",
      model_providers: {
        wardby_proxy: {
          name: "Wardby per-run proxy",
          base_url: `${config.proxyBaseUrl.replace(/\/$/, "")}/v1`,
          env_key: "CODEX_API_KEY",
          wire_api: "responses",
          // One failed request (a 5xx, a connection reset) or a dropped
          // stream would otherwise end the whole run and its spend. Every
          // retry is a new request through the proxy, so it passes the run's
          // budget reservation again; a budget refusal (429) retried is
          // refused again at no cost.
          request_max_retries: 3,
          stream_max_retries: 3,
          supports_websockets: false,
        },
      },
    },
  } as const;
}

export const createCodexSdkClient: WorkerClientFactory = (config) => new Codex(codexSdkOptions(config));
