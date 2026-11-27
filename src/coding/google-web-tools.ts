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

/**
 * A stored profile's webTools is not one of GOOGLE_WEB_TOOLS (only a direct database write can do this: the
 * column has no CHECK). Dispatch refuses the agent's runs and update_agent asks for the setting, with this
 * fixed text; the stored value itself is never echoed.
 */
export const WEB_TOOLS_SETTING_INVALID =
  "the stored webTools setting is invalid; set codingProfile.webTools to off, search or search-and-fetch with update_agent";
