/**
 * Gemini's server-side web tools a coding agent may use (codingProfile.webTools, phase 4): `googleSearch`
 * with "search", plus `urlContext` with "search-and-fetch". Off by default: Google runs the search or fetch,
 * outside the run's tunnel hosts, and bills grounded queries separately from tokens.
 */
export const GOOGLE_WEB_TOOLS = ["off", "search", "search-and-fetch"] as const;
export type WebTools = (typeof GOOGLE_WEB_TOOLS)[number];

export function isWebTools(value: unknown): value is WebTools {
  return typeof value === "string" && (GOOGLE_WEB_TOOLS as readonly string[]).includes(value);
}
