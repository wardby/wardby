/** Google AI Studio (Gemini Developer API) adapter. Ids are `google-ai-studio.<google model>`. */
import { GeminiLlmProvider } from "./gemini-provider.js";
import { simulatorGeminiOptions } from "../../config/test-simulators.js";

export const GOOGLE_AI_STUDIO_PREFIX = "google-ai-studio.";
const BASE = "https://generativelanguage.googleapis.com/v1beta";

export function googleAiStudioCredentialsPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GEMINI_API_KEY);
}

export class GoogleAiStudioLlmProvider extends GeminiLlmProvider {
  constructor(
    apiKey: string = process.env.GEMINI_API_KEY ?? "",
    options: { fetch?: typeof globalThis.fetch; baseUrl?: string } = {},
  ) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set — required by the Google AI Studio LlmProvider adapter.");
    // WARDBY_TEST_SIMULATORS (test only): the scripted model, a placeholder key, the credential-free fetch.
    const sim = options.fetch ? null : simulatorGeminiOptions("google-ai-studio");
    const base = sim?.baseUrl ?? options.baseUrl ?? BASE;
    const key = sim?.apiKey ?? apiKey;
    super(
      {
        url: (googleModel) => `${base}/models/${encodeURIComponent(googleModel)}:streamGenerateContent?alt=sse`,
        headers: async () => ({ "x-goog-api-key": key }),
        fetch: sim?.fetch ?? options.fetch ?? globalThis.fetch,
      },
      (modelId) =>
        modelId.startsWith(GOOGLE_AI_STUDIO_PREFIX) ? modelId.slice(GOOGLE_AI_STUDIO_PREFIX.length) : modelId,
    );
  }
}
