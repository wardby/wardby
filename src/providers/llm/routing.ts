/**
 * Model->provider routing. Becomes the single ProviderRegistry.llm and
 * dispatches each call to the adapter that owns `model`, so per-agent model
 * selection (Agent.model) selects the provider too — GPT and Claude agents
 * run in one deployment. Unknown model / duplicate registration fail closed.
 */
import type { LlmMessage, LlmProvider, LlmRequest, LlmStreamEvent, LlmToolDef } from "./types.js";

export interface LlmRegistration {
  provider: LlmProvider;
  models: string[];
}

export class RoutingLlmProvider implements LlmProvider {
  private readonly byModel = new Map<string, LlmProvider>();

  constructor(registrations: LlmRegistration[]) {
    for (const reg of registrations) {
      for (const model of reg.models) {
        if (this.byModel.has(model)) {
          throw new Error(
            `Model "${model}" is registered by more than one LLM provider — check the routing configuration.`,
          );
        }
        this.byModel.set(model, reg.provider);
      }
    }
  }

  listModels(): string[] {
    return [...this.byModel.keys()];
  }

  private resolve(model: string): LlmProvider {
    const provider = this.byModel.get(model);
    if (!provider) {
      throw new Error(
        `No LLM provider is registered for model "${model}". Known models: ${[...this.byModel.keys()].join(", ") || "(none)"}.`,
      );
    }
    return provider;
  }

  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamEvent> {
    return this.resolve(req.model).stream(req, signal);
  }

  countTokens(model: string, messages: LlmMessage[], tools?: LlmToolDef[]): Promise<number> {
    return this.resolve(model).countTokens(model, messages, tools);
  }

  priceUsd(
    model: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      cacheWriteTokens?: number;
    },
  ): number {
    return this.resolve(model).priceUsd(model, usage);
  }
}
