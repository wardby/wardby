/**
 * Enable-by-credential decision logic for the LLM seam: which adapters to
 * wire into RoutingLlmProvider, given environment credentials.
 *
 * Pure — no `fail()`/`process.exit` — so the CLI's `buildLlmProvider()` can
 * stay a thin wrapper that translates each outcome to `fail()`, while this
 * branching (which adapters to register) is unit-testable on its own.
 *
 * All five adapters register additively, purely by credential presence —
 * OpenAI, direct Anthropic, Bedrock-Claude, Vertex Gemini and Google AI Studio can all be active in one
 * deployment at once. An agent's `model` field (routed by RoutingLlmProvider)
 * picks which one handles its calls; there is no exclusive global mode.
 * A registration names only its provider — models come from the catalog.
 */
import { OpenAiLlmProvider, openaiCredentialsPresent } from "./openai.js";
import { AnthropicLlmProvider, anthropicCredentialsPresent } from "./anthropic.js";
import { BedrockClaudeLlmProvider, bedrockCredentialsPresent } from "./bedrock.js";
import { VertexGeminiLlmProvider, vertexGeminiCredentialsPresent } from "./vertex-gemini.js";
import { GoogleAiStudioLlmProvider, googleAiStudioCredentialsPresent } from "./google-ai-studio.js";
import type { LlmRegistration } from "./routing.js";

export type LlmRegistrationResult =
  { kind: "registrations"; registrations: LlmRegistration[] } | { kind: "no-credentials" };

export function resolveLlmRegistrations(env: NodeJS.ProcessEnv = process.env): LlmRegistrationResult {
  const registrations: LlmRegistration[] = [];
  if (openaiCredentialsPresent(env)) {
    registrations.push({ provider: "openai", adapter: new OpenAiLlmProvider(env.OPENAI_API_KEY) });
  }
  if (anthropicCredentialsPresent(env)) {
    registrations.push({ provider: "anthropic", adapter: new AnthropicLlmProvider(env.ANTHROPIC_API_KEY) });
  }
  if (bedrockCredentialsPresent(env)) {
    registrations.push({
      provider: "bedrock-claude",
      adapter: new BedrockClaudeLlmProvider(env.BEDROCK_REGION ?? env.AWS_REGION),
    });
  }
  if (vertexGeminiCredentialsPresent(env)) {
    registrations.push({
      provider: "vertex-gemini",
      adapter: new VertexGeminiLlmProvider(env.VERTEX_PROJECT || env.GOOGLE_CLOUD_PROJECT),
    });
  }
  if (googleAiStudioCredentialsPresent(env)) {
    registrations.push({ provider: "google-ai-studio", adapter: new GoogleAiStudioLlmProvider(env.GEMINI_API_KEY) });
  }
  if (registrations.length === 0) return { kind: "no-credentials" };
  return { kind: "registrations", registrations };
}
