/**
 * The control plane's client for the renderer service (src/renderer/server.ts). Errors are fixed
 * export codes only: no response text, URL or request content is carried into an error or a log,
 * so nothing from a board reaches a run record or the export row (exports.ts stores the code).
 */
import { MAX_EXPORT_BYTES, type Renderer } from "./exports.js";

/** A render of 50 boards can take a while; the job's stale sweep is 10 minutes. */
export const DEFAULT_RENDERER_TIMEOUT_MS = 120_000;

export function createRendererClient(baseUrl: string, opts: { timeoutMs?: number } = {}): Renderer {
  const base = baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RENDERER_TIMEOUT_MS;

  async function call(path: "/v1/png" | "/v1/pdf", body: unknown): Promise<Buffer> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new Error("export_renderer_unavailable");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(
        res.status === 429 || res.status === 503
          ? "export_renderer_unavailable"
          : res.status === 413
            ? "export_too_large"
            : "export_failed",
      );
    }
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_EXPORT_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error("export_too_large");
    }
    if (!res.body) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let size = 0;
    let tooLarge = false;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
        if (done || !value) break;
        size += value.byteLength;
        if (size > MAX_EXPORT_BYTES) {
          tooLarge = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(value);
      }
    } catch {
      // A dropped connection mid-body; the error text is not carried.
      throw new Error("export_renderer_unavailable");
    }
    if (tooLarge) throw new Error("export_too_large");
    return Buffer.concat(chunks, size);
  }

  return {
    png: (input) => call("/v1/png", { html: input.html, width: input.width }),
    pdf: (input) =>
      call("/v1/pdf", {
        boards: input.boards.map((b) => ({ html: b.html, width: b.width })),
        ...(input.paginate ? { paginate: true } : {}),
      }),
  };
}
