import { currentModelCatalog } from "../providers/llm/catalog-store.js";
import type { ModelCatalog } from "../providers/llm/catalog.js";
import type { ModelProvider } from "../providers/llm/catalog-types.js";
import type { ProxyProtocol } from "../providers/coding-proxy/types.js";

export const CODING_PROVIDERS = ["codex", "claude-code", "gemini-cli"] as const;

export type CodingProvider = (typeof CODING_PROVIDERS)[number];

/** How operators and owners see each provider named; one place, so every message names them alike. */
export const CODING_PROVIDER_LABELS: Readonly<Record<CodingProvider, string>> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  "gemini-cli": "Gemini CLI",
};

/** Which coding provider runs a model provider's models; Bedrock models are never coding models. */
export function codingProviderForModelProvider(provider: ModelProvider): CodingProvider | undefined {
  if (provider === "openai") return "codex";
  if (provider === "anthropic") return "claude-code";
  if (provider === "vertex-gemini" || provider === "google-ai-studio") return "gemini-cli";
  return undefined;
}

/**
 * Whether the provider runs its shell commands in a separate tool runner container (Claude Code). Codex
 * and Gemini CLI run them next to the agent, so their shells can read what the agent process holds:
 * those runs get read-only MCP tools, no native tools and no toolchain services. Fails closed: anything
 * but claude-code (an unknown or missing provider included) counts as running commands next to the agent.
 */
export function codingProviderHasToolRunner(provider: string | null | undefined): boolean {
  return provider === "claude-code";
}

/** The providers whose runs take codingProfile.subAgents (spec §3a); Codex accepts it with no effect. */
export function codingProviderTakesSubAgents(provider: string | null | undefined): boolean {
  return provider === "claude-code" || provider === "gemini-cli";
}

const PROTOCOLS: Readonly<Record<CodingProvider, ProxyProtocol>> = {
  codex: "openai-responses",
  "claude-code": "anthropic-messages",
  "gemini-cli": "gemini-generate-content",
};

/** The coding proxy protocol a provider's worker speaks; throws coding_provider_unsupported for any other name. */
export function codingProviderProtocol(provider: string): ProxyProtocol {
  if (!(CODING_PROVIDERS as readonly string[]).includes(provider)) throw new Error("coding_provider_unsupported");
  return PROTOCOLS[provider as CodingProvider];
}

export function codingProviderSupportsModel(
  provider: CodingProvider,
  model: string,
  catalog: ModelCatalog = currentModelCatalog(),
): boolean {
  const entry = catalog.get(model);
  return entry !== undefined && codingProviderForModelProvider(entry.provider) === provider;
}

export function assertCodingProvider(provider: string): asserts provider is CodingProvider {
  if (!CODING_PROVIDERS.includes(provider as CodingProvider)) {
    throw new Error(`Unsupported coding provider "${provider}".`);
  }
}

export function assertCodingProviderModel(provider: string, model: string): asserts provider is CodingProvider {
  assertCodingProvider(provider);
  if (!codingProviderSupportsModel(provider, model)) {
    throw new Error(`Model "${model}" is not supported by coding provider "${provider}".`);
  }
}
