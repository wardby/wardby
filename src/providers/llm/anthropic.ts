/**
 * Direct Anthropic (Claude) adapter for the LlmProvider seam. `@anthropic-ai/sdk`
 * is imported only here; all protocol/pricing-dispatch logic lives in the
 * shared ClaudeLlmProvider base class (claude-provider.ts) — this file's only
 * job is constructing the right client.
 */
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeLlmProvider } from "./claude-provider.js";
import type { CatalogLookup } from "./catalog-lookup.js";
import { simulatorModelClientOptions } from "../../config/test-simulators.js";

export function anthropicCredentialsPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

export class AnthropicLlmProvider extends ClaudeLlmProvider {
  constructor(apiKey: string = process.env.ANTHROPIC_API_KEY ?? "", client?: Anthropic, lookup?: CatalogLookup) {
    if (!client && !apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set — required by the Anthropic LlmProvider adapter.");
    }
    // WARDBY_TEST_SIMULATORS (test only): the scripted model, with a placeholder key the
    // credential-free fetch drops; the real key never goes there.
    const simulator = client ? null : simulatorModelClientOptions("anthropic");
    super(client ?? new Anthropic(simulator ?? { apiKey }), lookup);
  }
}
