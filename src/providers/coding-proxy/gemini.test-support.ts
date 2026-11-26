import { readFile } from "node:fs/promises";
import { vi } from "vitest";
import { MemoryProxyLedger } from "./memory-ledger.js";
import { CodingProxy, type ProxyResponseSink } from "./proxy.js";
import { shippedCatalog } from "../llm/catalog.js";
import { entryOf } from "../llm/catalog-types.js";
import { VERTEX_CREDENTIAL_REF } from "./gemini-upstream.js";
import type { ProxyAuditEvent } from "./types.js";
import type { RunStepSubmitter } from "../../core/run-steps/types.js";
import type { WebTools } from "../../coding/google-web-tools.js";

export const NOW = new Date("2026-11-26T12:00:00.000Z");
// Fake values only: never a real credential.
export const FAKE_GEMINI_KEY = "AIzaFAKEfakeFAKEfake0123456789abcdEFGH";
export const FAKE_VERTEX_TOKEN = "ya29.FAKEfakeFAKEfake0123456789";
export const STUDIO = "google-ai-studio.gemini-4-neon";
export const VERTEX_US = "us.gemini-4-neon";

export class TestSink implements ProxyResponseSink {
  status?: number;
  chunks: Buffer[] = [];
  ended = false;
  destroyed = false;
  onWrite?: (chunk: Buffer) => Promise<void>;
  start(status: number) {
    this.status = status;
  }
  async write(chunk: Uint8Array) {
    this.chunks.push(Buffer.from(chunk));
    await this.onWrite?.(Buffer.from(chunk));
  }
  end() {
    this.ended = true;
  }
  destroy() {
    this.destroyed = true;
  }
  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("");
export const usage = (prompt: number, out: number, cached = 0) => ({
  promptTokenCount: prompt,
  candidatesTokenCount: out,
  thoughtsTokenCount: 0,
  cachedContentTokenCount: cached,
});
export const okStream = () =>
  new Response(
    sse([
      { candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }], usageMetadata: usage(10, 1) },
      {
        candidates: [{ content: { role: "model", parts: [{ text: " there" }] }, finishReason: "STOP" }],
        usageMetadata: usage(10, 2, 4),
      },
    ]),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

export async function gemini(
  opts: {
    model?: string;
    webTools?: WebTools;
    fetch?: typeof globalThis.fetch;
    credentials?: { resolve(reference: string): Promise<string> };
    vertexToken?: () => Promise<string>;
    vertexProject?: string | null;
    budgetUsd?: number;
    ledger?: MemoryProxyLedger;
    steps?: RunStepSubmitter;
  } = {},
) {
  const model = opts.model ?? STUDIO;
  const entry = entryOf(shippedCatalog().require(model));
  const vertex = entry.provider === "vertex-gemini";
  const events: ProxyAuditEvent[] = [];
  const ledger = opts.ledger ?? new MemoryProxyLedger({ now: () => NOW });
  const fetch = vi.fn(opts.fetch ?? (async () => okStream()));
  const proxy = new CodingProxy({
    ledger,
    credentials: opts.credentials ?? { resolve: async () => FAKE_GEMINI_KEY },
    fetch,
    now: () => NOW,
    audit: (event) => events.push(event),
    ...(opts.steps ? { steps: opts.steps, runStepsCeiling: "detail" as const } : {}),
    gemini: {
      ...(opts.vertexProject === null ? {} : { vertexProject: opts.vertexProject ?? "example-project" }),
      vertexToken: opts.vertexToken ?? (async () => FAKE_VERTEX_TOKEN),
    },
  });
  const session = await proxy.createSession({
    runId: `run-${Math.random()}`,
    credentialRef: vertex ? VERTEX_CREDENTIAL_REF : "env:GEMINI_API_KEY",
    protocol: "gemini-generate-content",
    allowedModels: [model],
    deadlineAt: new Date(NOW.getTime() + 60_000),
    budgetUsd: opts.budgetUsd ?? 5,
    terms: { version: "test-v1", entry },
    ...(opts.steps ? { runStepsLevel: "detail" as const } : {}),
    ...(opts.webTools ? { webTools: opts.webTools } : {}),
  });
  const googleModel = vertex ? model.replace(/^(us|eu)\./, "") : model.replace(/^google-ai-studio\./, "");
  const execute = async (
    body: unknown,
    method: "streamGenerateContent" | "generateContent" = "streamGenerateContent",
    sink = new TestSink(),
  ) => {
    await proxy.execute(
      {
        bearer: session.capability,
        protocol: "gemini-generate-content",
        rawBody: typeof body === "string" ? body : JSON.stringify(body),
        gemini: { surface: vertex ? "vertex-express" : "ai-studio", model: googleModel, method },
      },
      sink,
    );
    return sink;
  };
  return { proxy, ledger, session, fetch, events, execute, entry };
}

export const body = (extra: Record<string, unknown> = {}) => ({
  contents: [{ role: "user", parts: [{ text: "hello" }] }],
  tools: [
    {
      functionDeclarations: [
        { name: "run_shell_command", description: "Run", parametersJsonSchema: { type: "object" } },
      ],
    },
  ],
  generationConfig: { maxOutputTokens: 1000 },
  ...extra,
});

/** The fixed code a parser or proxy refusal carries, or undefined when nothing was thrown. */
export function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
  return undefined;
}

export interface RecordedGeminiRequest {
  scenario: string;
  surface: "ai-studio" | "vertex-express";
  method: "streamGenerateContent" | "generateContent";
  model: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
/** The recorded Gemini CLI requests (Task 3). */
export const recordedGemini = async () =>
  (
    JSON.parse(await readFile(new URL("./fixtures/gemini-cli-0.70.0-requests.json", import.meta.url), "utf8")) as {
      requests: RecordedGeminiRequest[];
    }
  ).requests;
