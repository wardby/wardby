/**
 * The coding proxy's Gemini settings. CODING_VERTEX_PROJECT is the Google Cloud project Vertex AI calls of
 * Gemini coding runs are billed to; unset, VERTEX_PROJECT, then GOOGLE_CLOUD_PROJECT. AI Studio needs nothing
 * here: its key is the session's credential reference (CODING_GEMINI_CREDENTIAL_REF on the control plane).
 *
 * Only an invalid CODING_VERTEX_PROJECT stops start-up. VERTEX_PROJECT and GOOGLE_CLOUD_PROJECT are general
 * Google Cloud settings other tools may set: an invalid one is skipped with a warning (naming the variable,
 * never its value) and Vertex stays unset, so Vertex requests are released `vertex_project_unset`.
 */
import { logger } from "../core/logger.js";

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export interface CodingProxyGeminiConfig {
  vertexProject?: string;
}

export function loadCodingProxyGeminiConfig(env: NodeJS.ProcessEnv): CodingProxyGeminiConfig {
  for (const name of ["CODING_VERTEX_PROJECT", "VERTEX_PROJECT", "GOOGLE_CLOUD_PROJECT"] as const) {
    const value = env[name]?.trim();
    if (!value) continue;
    if (PROJECT_ID.test(value)) return { vertexProject: value };
    if (name === "CODING_VERTEX_PROJECT") throw new Error(`${name} must be a Google Cloud project id`);
    logger.warn(
      { module: "coding-proxy-gemini", event: "coding_proxy.vertex_project_invalid", variable: name },
      `coding proxy: ${name} is not a Google Cloud project id; Vertex AI stays unset for Gemini coding runs`,
    );
    return {};
  }
  return {};
}
