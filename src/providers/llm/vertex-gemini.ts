/**
 * Vertex AI Gemini adapter. Plain ids use the global endpoint; `us.`/`eu.` ids the
 * multi-region endpoints (priced at Vertex's non-global rate in the catalog).
 * Credentials: Application Default Credentials (GKE Workload Identity, gcloud ADC,
 * or GOOGLE_APPLICATION_CREDENTIALS). The project is VERTEX_PROJECT, else GOOGLE_CLOUD_PROJECT.
 */
import { GoogleAuth } from "google-auth-library";
import { GeminiLlmProvider } from "./gemini-provider.js";
import { simulatorGeminiOptions } from "../../config/test-simulators.js";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export function vertexGeminiCredentialsPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VERTEX_PROJECT || env.GOOGLE_CLOUD_PROJECT);
}

export function vertexLocation(modelId: string): { location: "global" | "us" | "eu"; googleModel: string } {
  for (const location of ["us", "eu"] as const) {
    if (modelId.startsWith(`${location}.`)) return { location, googleModel: modelId.slice(location.length + 1) };
  }
  return { location: "global", googleModel: modelId };
}

/** Vertex AI's endpoint for a location: the global host, or a multi-region's `rep` host. */
export const vertexBaseUrl = (location: string) =>
  location === "global" ? "https://aiplatform.googleapis.com" : `https://aiplatform.${location}.rep.googleapis.com`;

export class VertexGeminiLlmProvider extends GeminiLlmProvider {
  constructor(
    project: string = process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "",
    options: {
      fetch?: typeof globalThis.fetch;
      token?: () => Promise<string>;
      baseUrl?: (location: string) => string;
    } = {},
  ) {
    if (!project) {
      throw new Error("VERTEX_PROJECT (or GOOGLE_CLOUD_PROJECT) is required by the Vertex Gemini LlmProvider adapter.");
    }
    const sim = options.fetch ? null : simulatorGeminiOptions("vertex-gemini");
    // GoogleAuth is lazy: constructing it does no network I/O.
    const auth = sim || options.token ? null : new GoogleAuth({ scopes: [SCOPE] });
    const token =
      options.token ??
      (async () => {
        const value = (await (await auth!.getClient()).getAccessToken()).token;
        if (!value) throw new Error("no token");
        return value;
      });
    const base = sim ? () => sim.baseUrl : (options.baseUrl ?? vertexBaseUrl);
    super(
      {
        url: (_googleModel, modelId) => {
          const { location, googleModel } = vertexLocation(modelId);
          return `${base(location)}/v1/projects/${encodeURIComponent(project)}/locations/${location}/publishers/google/models/${encodeURIComponent(googleModel)}:streamGenerateContent?alt=sse`;
        },
        headers: async () => {
          if (sim) return { authorization: `Bearer ${sim.apiKey}` };
          try {
            return { authorization: `Bearer ${await token()}` };
          } catch {
            // Never pass ADC's own error on: it can name credential files or carry token detail.
            throw new Error(
              "vertex_auth_unavailable: could not get Google Cloud credentials for Vertex AI (Application Default Credentials).",
            );
          }
        },
        fetch: sim?.fetch ?? options.fetch ?? globalThis.fetch,
      },
      (modelId) => vertexLocation(modelId).googleModel,
    );
  }
}
