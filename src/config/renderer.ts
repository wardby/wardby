/**
 * The optional PNG/PDF export renderer (WARDBY_RENDERER_URL; unset = PNG and PDF exports are
 * refused as export_renderer_unavailable). RENDERER_DEPLOYMENT names the Kubernetes Deployment
 * that low-power mode scales (default wardby-renderer).
 */
export interface RendererConfig {
  /** Base URL without a trailing slash; null = no renderer. */
  url: string | null;
  deployment: string;
}

export const DEFAULT_RENDERER_DEPLOYMENT = "wardby-renderer";

export function loadRendererConfig(env: NodeJS.ProcessEnv = process.env): RendererConfig {
  const deployment = env.RENDERER_DEPLOYMENT?.trim() || DEFAULT_RENDERER_DEPLOYMENT;
  const raw = env.WARDBY_RENDERER_URL?.trim() ?? "";
  if (raw === "") return { url: null, deployment };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("WARDBY_RENDERER_URL must be an http(s) URL such as http://wardby-renderer:8796.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("WARDBY_RENDERER_URL must be an http(s) URL such as http://wardby-renderer:8796.");
  }
  // The value is never echoed: a URL with userinfo would put a credential in the error.
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("WARDBY_RENDERER_URL must not contain a user name or password.");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("WARDBY_RENDERER_URL must not contain a query or fragment.");
  }
  return { url: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, ""), deployment };
}
