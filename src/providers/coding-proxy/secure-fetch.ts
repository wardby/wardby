import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { FetchPolicyError, normalizeHost, resolveDestination, type Resolver } from "../../sandbox/fetch-policy.js";
import { requestPinned } from "../../sandbox/safe-fetch.js";

export const PROXY_EGRESS_ERROR = "proxy_egress_blocked";

export interface PinnedProxyFetchOptions {
  allowedHosts: string[];
  /** Any public https host may be fetched, not only `allowedHosts`: for the hop of a redirect that an
   *  allowed upstream issued (a signed cloud-storage URL). Private, loopback and cloud-metadata
   *  destinations stay blocked and the connection is still pinned to the address that was checked. */
  anyPublicHost?: boolean;
  resolve?: Resolver;
  connect?: typeof requestPinned;
}

function blocked(cause?: unknown): Error {
  return new Error(PROXY_EGRESS_ERROR, { cause });
}

/** The host a redirect points at, for diagnosing a blocked redirect. Host only: the path and
 *  query of a signed storage URL can carry a credential, so they never reach a log. */
export function redirectHost(location: string | null | undefined, base: string): string {
  if (!location) return "none";
  try {
    return new URL(location, base).hostname;
  } catch {
    return "unparseable";
  }
}

function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  return headers;
}

export function createPinnedProxyFetch(options: PinnedProxyFetchOptions): typeof globalThis.fetch {
  const allowedHosts = options.allowedHosts.map(normalizeHost);
  if (allowedHosts.length === 0 || allowedHosts.some((host) => isIP(host) !== 0)) throw blocked();

  return async (input, init = {}) => {
    try {
      if (typeof input !== "string" && !(input instanceof URL)) throw blocked();
      const url = input.toString();
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || isIP(normalizeHost(parsed.hostname)) !== 0) throw blocked();
      if (init.redirect && init.redirect !== "error" && init.redirect !== "manual") throw blocked();
      if (init.body !== undefined && init.body !== null && typeof init.body !== "string") throw blocked();

      const destination = await resolveDestination(url, {
        allowedHosts,
        restrictToAllowedHosts: !options.anyPublicHost,
        resolve: options.resolve,
      });
      const signal = init.signal ?? new AbortController().signal;
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const message = await (options.connect ?? requestPinned)(
        destination,
        { method: init.method, headers, body: init.body as string | undefined },
        signal,
      );
      const status = message.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        const headers = responseHeaders(message);
        message.destroy();
        // "manual" hands the redirect back unfollowed, so the caller decides whether its target is acceptable.
        if (init.redirect === "manual") return new Response(null, { status, headers });
        throw blocked(new Error(`upstream_redirect:${status}:${redirectHost(headers.get("location"), url)}`));
      }
      if (status < 100 || status > 599) {
        message.destroy();
        throw blocked(new Error(`upstream_status:${status}`));
      }
      const noBody = status === 204 || status === 205 || status === 304;
      const body = noBody ? null : (Readable.toWeb(message) as ReadableStream<Uint8Array>);
      return new Response(body, {
        status,
        statusText: message.statusMessage,
        headers: responseHeaders(message),
      });
    } catch (error) {
      if (error instanceof Error && error.message === PROXY_EGRESS_ERROR) throw error;
      if (error instanceof FetchPolicyError) throw blocked(error);
      throw error;
    }
  };
}
