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

type GatewayAnswer =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; causeCode?: string } }
  | undefined;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const gatewayError = (error: { code?: string; message?: string; causeCode?: string } | undefined, status: number) =>
  new GatewayError(
    (error?.code ?? "internal") as GatewayErrorCode,
    error?.message ?? `gateway answered ${status}`,
    typeof error?.causeCode === "string" ? error.causeCode : undefined,
  );

/**
 * One JSON POST, asked again (the same request) on a connection failure or `not_ready` until
 * `retryForMs` has passed; `{ ok: true }` → its result, any other answer → its GatewayError.
 */
async function postRetried(options: HttpTransportOptions, post: () => Promise<Response>): Promise<unknown> {
  const sleep = options.sleep ?? defaultSleep;
  const giveUpAt = Date.now() + (options.retryForMs ?? 120_000);
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await post();
    } catch (err) {
      if (Date.now() >= giveUpAt) {
        throw new GatewayError("internal", `gateway unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
      continue;
    }
    const body = (await response.json().catch(() => undefined)) as GatewayAnswer;
    if (body?.ok === true) return body.result;
    // Isolation not proven yet (a pod's NetworkPolicy is still being programmed): wait and ask again.
    if (body?.ok === false && body.error.code === "not_ready" && Date.now() < giveUpAt) {
      await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
      continue;
    }
    throw gatewayError(body?.ok === false ? body.error : undefined, response.status);
  }
}

/**
 * A Substrate worker's input (substrate-mode.ts): `POST <gateway>/native-gateway/v1/input` with the
 * bearer and no body, retried as `call` is. `options.url` is the input route's own URL.
 */
export function fetchSandboxInput(options: HttpTransportOptions): Promise<unknown> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return postRetried(options, () =>
    fetchImpl(options.url, { method: "POST", headers: { authorization: `Bearer ${options.capability}` } }),
  );
}

export function createHttpTransport(options: HttpTransportOptions): GatewayTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retryForMs = options.retryForMs ?? 120_000;
  const post = (request: GatewayRequest) =>
    fetchImpl(options.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.capability}` },
      body: JSON.stringify(request),
    });

  return {
    call(request) {
      return postRetried(options, () => post(request));
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
          { error?: { code: string; message: string; causeCode?: string } } | undefined;
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
