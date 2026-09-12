import { anthropicSupportedModels } from "../providers/llm/pricing-anthropic.js";
import { supportedModels as openaiSupportedModels } from "../providers/llm/pricing.js";

export const CODING_PROVIDERS = ["codex", "claude-code"] as const;

export type CodingProvider = (typeof CODING_PROVIDERS)[number];

const MODELS_BY_PROVIDER: Record<CodingProvider, ReadonlySet<string>> = {
  codex: new Set(openaiSupportedModels()),
  "claude-code": new Set(anthropicSupportedModels()),
};

export function codingProviderSupportsModel(provider: CodingProvider, model: string): boolean {
  return MODELS_BY_PROVIDER[provider].has(model);
}

export function assertCodingProviderModel(provider: string, model: string): asserts provider is CodingProvider {
  if (!CODING_PROVIDERS.includes(provider as CodingProvider)) {
    throw new Error(`Unsupported coding provider "${provider}".`);
  }
  if (!codingProviderSupportsModel(provider as CodingProvider, model)) {
    throw new Error(`Model "${model}" is not supported by coding provider "${provider}".`);
  }
}
