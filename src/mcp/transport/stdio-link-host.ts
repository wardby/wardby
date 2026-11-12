/**
 * stdio-only host for the signed links some tools hand out (the secret-entry
 * form, a run transcript download): an ephemeral, loopback-only HTTP server,
 * started lazily on the first link and closed after a period of inactivity.
 * stdio's MCP process has no other listener (see stdio.ts); this one exists
 * only while a link may be in use, consistent with stdio's "no token; the
 * operator is trusted" model: reachable only from this same machine, and
 * only a holder of a signed link can do anything with it.
 *
 * Request logging: none. A link's token travels in its `t` query parameter
 * (or, for a Bearer route, in `Authorization: Bearer`) and must never be logged.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { bearerToken } from "../tools/oauth-loopback-link.js";

/** Matches the requestState codec's own TTL (server.ts): no point outliving the tokens it serves. */
const IDLE_SHUTDOWN_MS = 10 * 60_000;

/** Handles one request for a path; receives the `t` query parameter. Must not log the token. */
export type StdioLinkHandler = (req: IncomingMessage, res: ServerResponse, token: string | null) => Promise<void>;

/**
 * A route whose link is presented as `Authorization: Bearer <token>` (the OAuth loopback routes the
 * CLI calls): its handler receives that token, or null, and never the `t` query parameter.
 */
export interface StdioBearerRoute {
  bearer: StdioLinkHandler;
}

export interface StdioLinkHost {
  /** The loopback URL for `path` carrying `token`; starts the server if it is not running. */
  urlFor(path: string, token: string): Promise<string>;
  /**
   * The server's loopback origin (`http://127.0.0.1:<port>`), for a link that carries its token
   * some other way (the OAuth loopback link's fragment); starts the server if it is not running.
   */
  origin(): Promise<string>;
}

export function createStdioLinkHost(routes: Record<string, StdioLinkHandler | StdioBearerRoute>): StdioLinkHost {
  let server: Server | undefined;
  let port = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleIdleShutdown(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      server?.close();
      server = undefined;
    }, IDLE_SHUTDOWN_MS);
    idleTimer.unref();
  }

  async function ensureServer(): Promise<number> {
    if (server) {
      scheduleIdleShutdown();
      return port;
    }
    const s = createServer((req, res) => {
      scheduleIdleShutdown();
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const route = Object.hasOwn(routes, url.pathname) ? routes[url.pathname] : undefined;
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      const [handler, token] =
        typeof route === "function"
          ? [route, url.searchParams.get("t")]
          : [route.bearer, bearerToken(req.headers.authorization)];
      // A failure here must never become an unhandled rejection: that would take
      // down the whole stdio MCP process, not just this request.
      handler(req, res, token).catch(() => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        if (!res.writableEnded) res.end("Internal error");
      });
    });
    server = s;
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.listen(0, "127.0.0.1", resolve);
    });
    const address = s.address();
    port = typeof address === "object" && address ? address.port : 0;
    scheduleIdleShutdown();
    return port;
  }

  return {
    async urlFor(path: string, token: string): Promise<string> {
      const p = await ensureServer();
      return `http://127.0.0.1:${p}${path}?t=${encodeURIComponent(token)}`;
    },
    async origin(): Promise<string> {
      return `http://127.0.0.1:${await ensureServer()}`;
    },
  };
}
