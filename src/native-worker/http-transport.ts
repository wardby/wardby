/**
 * The worker's HTTP transport to the native sandbox gateway. One-shot calls are
 * retried with the same request (same callId) on a connection failure until a
 * deadline, so a control-plane replica restarting is a retry, not a failure:
 * the gateway replays a finished call's result instead of acting again. A
 * model stream is never retried — its reservation is already taken.
 */

import type { LlmStreamEvent } from "../providers/llm/types.js";
import { GatewayError, type GatewayErrorCode, type GatewayRequest } from "./protocol.js";
import type { GatewayTransport } from "./worker.js";

export interface HttpTransportOptions {
  url: string;
  capability: string;
  fetch?: typeof globalThis.fetch;
  /** How long a one-shot call keeps retrying connection failures. */
  retryForMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 4_000];

export function createHttpTransport(options: HttpTransportOptions): GatewayTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryForMs = options.retryForMs ?? 120_000;
  const post = (request: GatewayRequest) =>
    fetchImpl(options.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.capability}` },
      body: JSON.stringify(request),
    });
  const gatewayError = (error: { code?: string; message?: string } | undefined, status: number) =>
    new GatewayError((error?.code ?? "internal") as GatewayErrorCode, error?.message ?? `gateway answered ${status}`);

  return {
    async call(request) {
      const giveUpAt = Date.now() + retryForMs;
      for (let attempt = 0; ; attempt += 1) {
        let response: Response;
        try {
          response = await post(request);
        } catch (err) {
          if (Date.now() >= giveUpAt) {
            throw new GatewayError(
              "internal",
              `gateway unreachable: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
          continue;
        }
        const body = (await response.json().catch(() => undefined)) as
          { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } } | undefined;
        if (body?.ok === true) return body.result;
        // Isolation not proven yet (a pod's NetworkPolicy is still being programmed): wait and ask again.
        if (body?.ok === false && body.error.code === "not_ready" && Date.now() < giveUpAt) {
          await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
          continue;
        }
        throw gatewayError(body?.ok === false ? body.error : undefined, response.status);
      }
    },

    async *stream(request): AsyncIterable<LlmStreamEvent> {
      const giveUpAt = Date.now() + retryForMs;
      let response: Response;
      for (let attempt = 0; ; attempt += 1) {
        try {
          response = await post(request);
        } catch (err) {
          throw new GatewayError(
            "internal",
            `gateway unreachable: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (response.headers.get("content-type")?.includes("application/x-ndjson") && response.body) break;
        const body = (await response.json().catch(() => undefined)) as
          { error?: { code: string; message: string } } | undefined;
        // Refused before any reservation was taken, so asking again is safe.
        if (body?.error?.code === "not_ready" && Date.now() < giveUpAt) {
          await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
          continue;
        }
        throw gatewayError(body?.error, response.status);
      }
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const frame = JSON.parse(line) as {
            event?: LlmStreamEvent;
            end?: true;
            error?: { code: string; message: string };
          };
          if (frame.event) yield frame.event;
          else if (frame.error) throw gatewayError(frame.error, 200);
          else if (frame.end) return;
        }
      }
      throw new GatewayError("internal", "The gateway stream ended without a result.");
    },
  };
}
