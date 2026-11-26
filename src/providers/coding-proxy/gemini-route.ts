/**
 * Gemini calls name their model and method in the path. The coding proxy serves the AI Studio shape and Vertex
 * AI's express-mode shape (what the Gemini CLI sends with an API key), and only the two content-generating
 * methods. A stream call carries exactly `alt=sse`; nothing else may be in the query (a `key=` never passes).
 */
export type GeminiSurface = "ai-studio" | "vertex-express";
export type GeminiMethod = "streamGenerateContent" | "generateContent";
export interface GeminiRoute {
  surface: GeminiSurface;
  /** Google's model id, as in the path (no wardby prefix). */
  model: string;
  method: GeminiMethod;
}
export type GeminiRouteMatch =
  { ok: true; route: GeminiRoute } | { ok: false; code: "gemini_method_not_supported" | "gemini_query_not_allowed" };

const PREFIXES: readonly [GeminiSurface, string][] = [
  ["ai-studio", "/v1beta/models/"],
  ["vertex-express", "/v1beta1/publishers/google/models/"],
];
const TARGET = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99}):([A-Za-z]{1,64})$/;

export function matchGeminiRoute(url: string | undefined): GeminiRouteMatch | undefined {
  if (!url) return undefined;
  const at = url.indexOf("?");
  const path = at < 0 ? url : url.slice(0, at);
  const query = at < 0 ? "" : url.slice(at + 1);
  for (const [surface, prefix] of PREFIXES) {
    if (!path.startsWith(prefix)) continue;
    const target = TARGET.exec(path.slice(prefix.length));
    if (!target || target[1].includes("..")) return { ok: false, code: "gemini_method_not_supported" };
    const method = target[2];
    if (method !== "streamGenerateContent" && method !== "generateContent") {
      return { ok: false, code: "gemini_method_not_supported" };
    }
    if (query !== (method === "streamGenerateContent" ? "alt=sse" : ""))
      return { ok: false, code: "gemini_query_not_allowed" };
    return { ok: true, route: { surface, model: target[1], method } };
  }
  return undefined;
}
