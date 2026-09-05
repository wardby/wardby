/**
 * Enable-by-credential decision logic for the LLM seam: which adapters to
 * wire into RoutingLlmProvider, given provider config and environment
 * credentials.
 *
 * Pure — no `fail()`/`process.exit` — so the CLI's `buildLlmProvider()` can
 * stay a thin wrapper that translates each outcome to `fail()`, while this
 * branching (bedrock reserved / no credentials / which adapters to
 * register) is unit-testable on its own.
 */
import type { ProviderConfig } from "../../config/providers.js";
import { OpenAiLlmProvider, openaiCredentialsPresent } from "./openai.js";
import { supportedModels as openaiSupportedModels } from "./pricing.js";
import { AnthropicLlmProvider, anthropicCredentialsPresent, anthropicSupportedModels } from "./anthropic.js";
import type { LlmRegistration } from "./routing.js";

export type LlmRegistrationResult =
  | { kind: "registrations"; registrations: LlmRegistration[] }
  | { kind: "bedrock-reserved" }
  | { kind: "no-credentials" };

export function resolveLlmRegistrations(
  config: Pick<ProviderConfig, "llm">,
  env: NodeJS.ProcessEnv = process.env,
): LlmRegistrationResult {
  if (config.llm === "bedrock") {
    return { kind: "bedrock-reserved" };
  }
  const registrations: LlmRegistration[] = [];
  if (openaiCredentialsPresent(env)) {
    registrations.push({ provider: new OpenAiLlmProvider(env.OPENAI_API_KEY), models: openaiSupportedModels() });
  }
  if (anthropicCredentialsPresent(env)) {
    registrations.push({ provider: new AnthropicLlmProvider(env.ANTHROPIC_API_KEY), models: anthropicSupportedModels() });
  }
  if (registrations.length === 0) {
    return { kind: "no-credentials" };
  }
  return { kind: "registrations", registrations };
}
