/**
 * stdio-only host for the secret-entry form: an ephemeral, loopback-only
 * HTTP server, started lazily on the first pending elicitation and closed
 * after a period of inactivity. stdio's MCP process has no other listener
 * (see mcp/transport/stdio.ts) — this one exists only while a secret entry
 * is actually pending, consistent with stdio's "no token; the operator is
 * trusted" model: reachable only from this same machine, and only a holder
 * of the one-time signed URL can do anything with it.
 */
import { createServer, type Server } from "node:http";
import type { SecretFormDeps } from "./secret-elicitation-form.js";
import { handleSecretElicitationForm, readFormBody } from "./secret-elicitation-form.js";

/** Matches the requestState codec's own TTL (server.ts) — no point outliving the tokens it serves. */
const IDLE_SHUTDOWN_MS = 10 * 60_000;

export interface StdioSecretElicitationHost {
  urlFor(token: string): Promise<string>;
}

export function createStdioSecretElicitationHost(deps: SecretFormDeps): StdioSecretElicitationHost {
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
      if (url.pathname !== "/secret") {
        res.writeHead(404).end();
        return;
      }
      void handleSecretElicitationForm(req.method, url.searchParams.get("t"), () => readFormBody(req), res, deps);
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
    async urlFor(token: string): Promise<string> {
      const p = await ensureServer();
      return `http://127.0.0.1:${p}/secret?t=${encodeURIComponent(token)}`;
    },
  };
}
