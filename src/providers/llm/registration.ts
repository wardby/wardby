/**
 * Enable-by-credential decision logic for the LLM seam: which adapters to
 * wire into RoutingLlmProvider, given environment credentials.
 *
 * Pure — no `fail()`/`process.exit` — so the CLI's `buildLlmProvider()` can
 * stay a thin wrapper that translates each outcome to `fail()`, while this
 * branching (which adapters to register) is unit-testable on its own.
 *
 * All three adapters register additively, purely by credential presence —
 * OpenAI, direct Anthropic, and Bedrock-Claude can all be active in one
 * deployment at once. An agent's `model` field (routed by RoutingLlmProvider)
 * picks which one handles its calls; there is no exclusive global mode.
 */
import { OpenAiLlmProvider, openaiCredentialsPresent } from "./openai.js";
import { supportedModels as openaiSupportedModels } from "./pricing.js";
import { AnthropicLlmProvider, anthropicCredentialsPresent, anthropicSupportedModels } from "./anthropic.js";
import { BedrockClaudeLlmProvider, bedrockCredentialsPresent, bedrockClaudeSupportedModels } from "./bedrock.js";
import type { LlmRegistration } from "./routing.js";

export type LlmRegistrationResult =
  | { kind: "registrations"; registrations: LlmRegistration[] }
  | { kind: "no-credentials" };

export function resolveLlmRegistrations(env: NodeJS.ProcessEnv = process.env): LlmRegistrationResult {
  const registrations: LlmRegistration[] = [];
  if (openaiCredentialsPresent(env)) {
    registrations.push({ provider: new OpenAiLlmProvider(env.OPENAI_API_KEY), models: openaiSupportedModels() });
  }
  if (anthropicCredentialsPresent(env)) {
    registrations.push({
      provider: new AnthropicLlmProvider(env.ANTHROPIC_API_KEY),
      models: anthropicSupportedModels(),
    });
  }
  if (bedrockCredentialsPresent(env)) {
    registrations.push({
      provider: new BedrockClaudeLlmProvider(env.BEDROCK_REGION ?? env.AWS_REGION),
      models: bedrockClaudeSupportedModels(),
    });
  }
  if (registrations.length === 0) {
    return { kind: "no-credentials" };
  }
  return { kind: "registrations", registrations };
}
