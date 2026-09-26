/**
 * The registry core's guard around every metadata and OSV request: a
 * timeout covering the request and its whole body, and a byte cap on the
 * body. The body is read here, within both limits, and handed back as an
 * in-memory Response, so an adapter's (or the audit's) `response.json()`
 * can neither hang nor buffer an unbounded document. Downloads do not go
 * through this: they stream with their own size and idle limits.
 */
import { RegistryError, type UpstreamFetch } from "../../../coding/registry/types.js";

export const DEFAULT_METADATA_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_METADATA_BYTES = 64 * 1024 * 1024;

export interface MetadataFetchLimits {
  timeoutMs: number;
  maxBytes: number;
}

function timedOut(signal: AbortSignal, error: unknown): boolean {
  if (signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError") return true;
  return error instanceof Error && error.name === "TimeoutError";
}

function unavailable(url: string): RegistryError {
  return new RegistryError(504, "wardby_upstream_unavailable", `${new URL(url).hostname} did not answer in time`);
}

function tooLarge(url: string, maxBytes: number): RegistryError {
  return new RegistryError(
    502,
    "wardby_metadata_too_large",
    `${new URL(url).hostname} returned more than ${Math.floor(maxBytes / (1024 * 1024))} MiB of metadata`,
  );
}

export function boundedMetadataFetch(upstream: UpstreamFetch, limits: MetadataFetchLimits): UpstreamFetch {
  return async (url, init = {}) => {
    const timeout = AbortSignal.timeout(limits.timeoutMs);
    const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
    try {
      const response = await upstream(url, { ...init, signal });
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > limits.maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw tooLarge(url, limits.maxBytes);
      }
      if (!response.body) return response;
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      // The timeout also bounds a body that trickles: a stalled read is
      // abandoned when the signal fires, even if the upstream ignores it.
      const aborted = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason as Error);
        signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      });
      aborted.catch(() => undefined);
      try {
        for (;;) {
          const { done, value } = await Promise.race([reader.read(), aborted]);
          if (done) break;
          total += value.byteLength;
          if (total > limits.maxBytes) throw tooLarge(url, limits.maxBytes);
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      }
      const nullBody = [101, 204, 205, 304].includes(response.status);
      return new Response(nullBody ? null : Buffer.concat(chunks), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      if (error instanceof RegistryError) throw error;
      if (timedOut(signal, error)) throw unavailable(url);
      throw error;
    }
  };
}
