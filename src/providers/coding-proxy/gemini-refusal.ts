/**
 * The proxy's own refusals on a Gemini route, in Google's error shape, so the Gemini CLI reads
 * them as it reads Google's: `[API Error: <message>]`, exit code = HTTP status mod 256. `type` keeps
 * wardby's code for anything that matches on it. Imports nothing; the body never carries a value
 * from the request.
 */

/**
 * The budget refusal's message. The CLI retries a 429 ten times over about 3.5 minutes unless the
 * message says the quota is zero (`/limit:\s*0/`); with it, the run stops after one call.
 */
export const GEMINI_BUDGET_EXHAUSTED_MESSAGE = "wardby_budget_exhausted (limit: 0)";

/** google.rpc.Code names for the statuses the proxy refuses with. */
const GOOGLE_STATUS: Readonly<Record<number, string>> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ABORTED",
  413: "INVALID_ARGUMENT",
  415: "INVALID_ARGUMENT",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  502: "UNAVAILABLE",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};

export function geminiRefusalBody(status: number, code: string): string {
  const message = code === "wardby_budget_exhausted" ? GEMINI_BUDGET_EXHAUSTED_MESSAGE : code;
  return JSON.stringify({ error: { code: status, status: GOOGLE_STATUS[status] ?? "UNKNOWN", message, type: code } });
}
