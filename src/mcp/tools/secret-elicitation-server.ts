/**
 * stdio-only host for the secret-entry form, on the shared ephemeral
 * loopback link host (mcp/transport/stdio-link-host.ts).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SecretFormDeps } from "./secret-elicitation-form.js";
import { handleSecretElicitationForm, readFormBody } from "./secret-elicitation-form.js";
import { createStdioLinkHost, type StdioLinkHandler } from "../transport/stdio-link-host.js";

/** The loopback path the form is served at on stdio. */
export const STDIO_SECRET_PATH = "/secret";

export interface StdioSecretElicitationHost {
  urlFor(token: string): Promise<string>;
}

/** The secret form as a link-host route. */
export function secretFormRoute(deps: SecretFormDeps): StdioLinkHandler {
  return (req: IncomingMessage, res: ServerResponse, token: string | null) =>
    handleSecretElicitationForm(req.method, token, () => readFormBody(req), res, deps);
}

/** A link host serving only the secret form (the composition root shares one host across routes). */
export function createStdioSecretElicitationHost(deps: SecretFormDeps): StdioSecretElicitationHost {
  const host = createStdioLinkHost({ [STDIO_SECRET_PATH]: secretFormRoute(deps) });
  return { urlFor: (token) => host.urlFor(STDIO_SECRET_PATH, token) };
}
