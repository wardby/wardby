/**
 * Model->provider routing over the model catalog. Becomes the single
 * ProviderRegistry.llm: each call's model is looked up in the current
 * catalog, and the adapter registered for that entry's provider handles it.
 * A model is routable when it is in the catalog AND its provider has
 * credentials (registration.ts). Unknown model / unconfigured provider /
 * duplicate registration all fail closed.
 */
import { currentModelCatalog } from "./catalog-store.js";
import type { ModelCatalog } from "./catalog.js";
import {
  ModelUnavailableError,
  type CatalogEntry,
  type ModelProvider,
  type ResolvedCatalogEntry,
} from "./catalog-types.js";
import type {
  LlmEffort,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
  LlmStreamHooks,
  LlmToolDef,
} from "./types.js";

/** Effort levels `model` accepts, from the current catalog; no credentials needed (config-time validation). */
export function modelSupportedEfforts(model: string): readonly LlmEffort[] {
  return currentModelCatalog().get(model)?.efforts ?? [];
}

export function modelAcceptsEffort(model: string, effort: LlmEffort): boolean {
  return modelSupportedEfforts(model).includes(effort);
}

/** An adapter that can be pinned to one run's stored catalog entry. */
export interface CatalogLlmAdapter extends LlmProvider {
  withEntry(entry: CatalogEntry): LlmProvider;
}

export interface LlmRegistration {
  provider: ModelProvider;
  adapter: CatalogLlmAdapter;
}

export class RoutingLlmProvider implements LlmProvider {
  private readonly byProvider = new Map<ModelProvider, CatalogLlmAdapter>();

  constructor(
    registrations: LlmRegistration[],
    private readonly catalog: () => ModelCatalog = currentModelCatalog,
  ) {
    for (const reg of registrations) {
      if (this.byProvider.has(reg.provider)) {
        throw new Error(
          `LLM provider "${reg.provider}" is registered more than once — check the routing configuration.`,
        );
      }
      this.byProvider.set(reg.provider, reg.adapter);
    }
  }

  hasProvider(provider: ModelProvider): boolean {
    return this.byProvider.has(provider);
  }

  /** Model ids this deployment can run right now. */
  listModels(): string[] {
    return this.catalog()
      .entries()
      .filter((e) => this.byProvider.has(e.provider))
      .map((e) => e.modelId);
  }

  /** The current catalog entry for a runnable model; throws ModelUnavailableError otherwise. */
  entryFor(model: string): ResolvedCatalogEntry {
    const entry = this.catalog().require(model);
    if (!this.byProvider.has(entry.provider)) throw new ModelUnavailableError(model, "provider_not_configured");
    return entry;
  }

  /** A provider bound to one run's stored entry: prices and shapes requests from it, never the live catalog. */
  forRun(entry: CatalogEntry): LlmProvider {
    const adapter = this.byProvider.get(entry.provider);
    if (!adapter) throw new ModelUnavailableError(entry.modelId, "provider_not_configured");
    return adapter.withEntry(entry);
  }

  private resolve(model: string): CatalogLlmAdapter {
    return this.byProvider.get(this.entryFor(model).provider)!;
  }

  stream(req: LlmRequest, signal?: AbortSignal, hooks?: LlmStreamHooks): AsyncIterable<LlmStreamEvent> {
    return this.resolve(req.model).stream(req, signal, hooks);
  }

  countTokens(model: string, messages: LlmMessage[], tools?: LlmToolDef[]): Promise<number> {
    return this.resolve(model).countTokens(model, messages, tools);
  }

  priceUsd(
    model: string,
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number },
  ): number {
    return this.resolve(model).priceUsd(model, usage);
  }
}
