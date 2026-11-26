/** A Vertex session's credential reference: the proxy's own Google identity (ADC), never an env value. */
export const VERTEX_CREDENTIAL_REF = "gcp:application-default";

export type GeminiBackend = "vertex-gemini" | "google-ai-studio";

export function isGeminiProvider(provider: string): provider is GeminiBackend {
  return provider === "vertex-gemini" || provider === "google-ai-studio";
}

/** Where a Gemini request goes upstream (filled in with the forwarding path). */
export interface GeminiProxyOptions {
  /** The Google Cloud project Vertex requests are addressed to. */
  vertexProject?: string;
  /** Mints the proxy's own Vertex access token (Application Default Credentials). */
  vertexToken?: () => Promise<string>;
}

/** The Gemini request line the HTTP layer parsed from the path. */
export interface GeminiRequestTarget {
  surface: "ai-studio" | "vertex-express";
  /** Google's model id, not wardby's. */
  model: string;
  method: "streamGenerateContent" | "generateContent";
}
