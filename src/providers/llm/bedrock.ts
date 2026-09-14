/**
 * Bedrock-Claude adapter for the LlmProvider seam. `@anthropic-ai/bedrock-sdk`
 * is imported only here; all protocol/pricing-dispatch logic lives in the
 * shared ClaudeLlmProvider base class (claude-provider.ts) — AnthropicBedrock
 * exposes the identical .messages.stream() surface as @anthropic-ai/sdk, so
 * this file's only job is constructing the right client and pricing module.
 *
 * Named BedrockClaudeLlmProvider, not BedrockLlmProvider: Bedrock hosts
 * multiple model vendors, and this adapter only ever speaks the
 * Anthropic-native protocol for Claude models. A future non-Claude Bedrock
 * adapter gets its own name, not a rename of this one.
 */
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { ClaudeLlmProvider } from "./claude-provider.js";
import { bedrockClaudePriceUsd, getBedrockClaudePricing } from "./pricing-bedrock-claude.js";

export { bedrockClaudeSupportedModels } from "./pricing-bedrock-claude.js";

export function bedrockCredentialsPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  // A region is the one thing Bedrock always needs; AWS resolves actual
  // credentials from the standard default chain (env keys, shared config,
  // IAM role) — this only gates whether the adapter registers at all.
  return Boolean(env.BEDROCK_REGION ?? env.AWS_REGION);
}

export class BedrockClaudeLlmProvider extends ClaudeLlmProvider {
  constructor(region: string = process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "", client?: AnthropicBedrock) {
    if (!client && !region) {
      throw new Error("BEDROCK_REGION (or AWS_REGION) is required by the Bedrock Claude LlmProvider adapter.");
    }
    super(client ?? new AnthropicBedrock({ awsRegion: region }), {
      getPricing: getBedrockClaudePricing,
      priceUsd: bedrockClaudePriceUsd,
    });
  }
}
