/**
 * The coding proxy's Gemini settings. CODING_VERTEX_PROJECT is the Google Cloud project Vertex AI calls of
 * Gemini coding runs are billed to; unset, VERTEX_PROJECT, then GOOGLE_CLOUD_PROJECT. AI Studio needs nothing
 * here: its key is the session's credential reference (CODING_GEMINI_CREDENTIAL_REF on the control plane).
 */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export interface CodingProxyGeminiConfig {
  vertexProject?: string;
}

export function loadCodingProxyGeminiConfig(env: NodeJS.ProcessEnv): CodingProxyGeminiConfig {
  for (const name of ["CODING_VERTEX_PROJECT", "VERTEX_PROJECT", "GOOGLE_CLOUD_PROJECT"] as const) {
    const value = env[name]?.trim();
    if (!value) continue;
    if (!PROJECT_ID.test(value)) throw new Error(`${name} must be a Google Cloud project id`);
    return { vertexProject: value };
  }
  return {};
}
