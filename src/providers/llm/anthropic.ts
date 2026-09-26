/**
 * Direct Anthropic (Claude) adapter for the LlmProvider seam. `@anthropic-ai/sdk`
 * is imported only here; all protocol/pricing-dispatch logic lives in the
 * shared ClaudeLlmProvider base class (claude-provider.ts) — this file's only
 * job is constructing the right client and pricing module.
 */
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeLlmProvider } from "./claude-provider.js";
import { anthropicPriceUsd, anthropicSupportedEfforts, getAnthropicPricing } from "./pricing-anthropic.js";

export { anthropicSupportedModels } from "./pricing-anthropic.js";

export function anthropicCredentialsPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

export class AnthropicLlmProvider extends ClaudeLlmProvider {
  constructor(apiKey: string = process.env.ANTHROPIC_API_KEY ?? "", client?: Anthropic) {
    if (!client && !apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set — required by the Anthropic LlmProvider adapter.");
    }
    super(client ?? new Anthropic({ apiKey }), {
      getPricing: getAnthropicPricing,
      priceUsd: anthropicPriceUsd,
      supportedEfforts: anthropicSupportedEfforts,
    });
  }
}
