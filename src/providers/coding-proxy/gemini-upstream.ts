import { GoogleAuth } from "google-auth-library";
import { vertexBaseUrl, vertexLocation } from "../llm/vertex-gemini.js";
import { googleModelId } from "./gemini-request.js";
import type { GeminiMethod } from "./gemini-route.js";

/** A Vertex session's credential reference: the proxy's own Google identity (ADC), never an env value. */
export const VERTEX_CREDENTIAL_REF = "gcp:application-default";

export type GeminiBackend = "vertex-gemini" | "google-ai-studio";

export function isGeminiProvider(provider: string): provider is GeminiBackend {
  return provider === "vertex-gemini" || provider === "google-ai-studio";
}

/** The hosts Gemini calls may reach; the pinned fetch allows only these (plus the other protocols' own). */
export const GEMINI_UPSTREAM_HOSTS = [
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
  "aiplatform.us.rep.googleapis.com",
  "aiplatform.eu.rep.googleapis.com",
] as const;
const AI_STUDIO_BASE = "https://generativelanguage.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export interface GeminiUpstreamOptions {
  /** Tests only. */
  aiStudioBase?: string;
  /** Tests only. */
  vertexBase?: (location: "global" | "us" | "eu") => string;
  /** CODING_VERTEX_PROJECT (else VERTEX_PROJECT, GOOGLE_CLOUD_PROJECT): the project Vertex calls are billed to. */
  vertexProject?: string;
  /** The proxy's own access token for Vertex (default: Application Default Credentials). Raw token, no "Bearer". */
  vertexToken?: () => Promise<string>;
}

/** Why a Gemini call could not be sent: a fixed code, safe to audit. */
export class GeminiUpstreamUnavailable extends Error {
  constructor(readonly code: "vertex_project_unset" | "vertex_auth_unavailable" | "gemini_session_invalid") {
    super(code);
    this.name = "GeminiUpstreamUnavailable";
  }
}

/** The upstream URL of a Gemini call. Only `alt=sse` (stream calls) ever goes in its query: never a credential. */
export function geminiUpstreamUrl(
  backend: GeminiBackend,
  modelId: string,
  method: GeminiMethod,
  options: GeminiUpstreamOptions,
): string {
  const query = method === "streamGenerateContent" ? "?alt=sse" : "";
  const model = encodeURIComponent(googleModelId(modelId, backend));
  if (backend === "google-ai-studio") {
    return `${options.aiStudioBase ?? AI_STUDIO_BASE}/v1beta/models/${model}:${method}${query}`;
  }
  if (!options.vertexProject) throw new GeminiUpstreamUnavailable("vertex_project_unset");
  const { location } = vertexLocation(modelId);
  const base = (options.vertexBase ?? vertexBaseUrl)(location);
  return `${base}/v1beta1/projects/${encodeURIComponent(options.vertexProject)}/locations/${location}/publishers/google/models/${model}:${method}${query}`;
}

/**
 * The proxy's own Google identity through Application Default Credentials: Workload Identity on GKE (via the
 * metadata server), gcloud ADC or GOOGLE_APPLICATION_CREDENTIALS elsewhere. The library caches and refreshes the
 * token. Its errors can name credential files or carry token detail, so only a fixed code leaves here.
 */
export function vertexAccessTokenSource(): () => Promise<string> {
  let auth: GoogleAuth | undefined;
  return async () => {
    try {
      auth ??= new GoogleAuth({ scopes: [SCOPE] });
      const token = (await (await auth.getClient()).getAccessToken()).token;
      if (!token) throw new Error();
      return token;
    } catch {
      throw new GeminiUpstreamUnavailable("vertex_auth_unavailable");
    }
  };
}
