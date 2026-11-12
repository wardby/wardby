/**
 * Viewer HTTP routes: GET /admin/api/graph, /admin/api/runs/:id, /admin/api/infra and the
 * /admin/api/events SSE stream. Read-only and deployment-wide, so every route
 * authenticates and then requires the privileged `admin:view` scope (admin role
 * only) BEFORE touching the database or the event bus. McpErrors propagate to
 * the server's catch (401/403 + WWW-Authenticate).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PrismaClient } from "#prisma";
import type { McpRequestContext } from "../mcp/context.js";
import { requireScope } from "../mcp/auth/resource-server.js";
import { sendJson } from "../mcp/transport/streamable-http.js";
import type { InfraInfo } from "./api-schema.js";
import { loadGraph, parseSince, type IssueSites } from "./graph.js";
import { DEFAULT_GRAPH_LIMIT, MAX_GRAPH_LIMIT, SSE_HEARTBEAT_MS } from "./limits.js";
import { loadRunDetail } from "./run-detail.js";
import type { ViewerEventBus } from "./event-bus.js";
import { openSseStream } from "../mcp/transport/sse-stream.js";

export const VIEWER_API_PREFIX = "/admin/api/";
/** A stream whose unsent backlog exceeds this is ended; the client reconnects and resyncs. */
export const SSE_MAX_BUFFERED_BYTES = 1024 * 1024;

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ViewerApiDeps {
  db: PrismaClient;
  bus: ViewerEventBus;
  authenticate: (authorization: string | undefined) => Promise<McpRequestContext>;
  canonicalUri: string;
  /** How this deployment runs coding jobs (built once at startup; GET /admin/api/infra). */
  infra: InfraInfo;
  /** Issue-tracker site origins by provider, for issue and comment links (empty when none is configured). */
  issueSites?: IssueSites;
  heartbeatMs?: number; // tests
  maxBufferedBytes?: number; // tests
}

export interface ViewerApi {
  /** Returns false when the path is not a viewer route (caller falls through to 404). */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** Ends every open event stream (server shutdown). */
  closeStreams(): void;
}

export function createViewerApi(deps: ViewerApiDeps): ViewerApi {
  const heartbeatMs = deps.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const maxBufferedBytes = deps.maxBufferedBytes ?? SSE_MAX_BUFFERED_BYTES;
  const streams = new Set<() => void>();
  let nextEventId = 0;

  function openStream(req: IncomingMessage, res: ServerResponse): void {
    const stream = openSseStream(req, res, { heartbeatMs, maxBufferedBytes });
    if (!stream) return;
    stream.send(`event: hello\ndata: ${JSON.stringify({ connected: deps.bus.connected() })}\n\n`);
    stream.onEnd(
      deps.bus.subscribe((event) => {
        stream.send(`id: ${++nextEventId}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
      }),
    );
    // Every transition to live (including the bus's first connect, which
    // usually lands just after this stream opens) may follow missed events, so
    // tell the client to refetch the graph. Going down only changes status.
    stream.onEnd(
      deps.bus.onState((live) => {
        stream.send(`event: status\ndata: ${JSON.stringify({ connected: live })}\n\n`);
        if (live) stream.send("event: resync\ndata: {}\n\n");
      }),
    );
    const close = () => stream.close();
    streams.add(close);
    stream.onEnd(() => streams.delete(close));
  }

  return {
    async handle(req, res, url) {
      const path = url.pathname;
      const runMatch = /^\/admin\/api\/runs\/([^/]*)$/.exec(path);
      const isGraph = path === "/admin/api/graph";
      const isEvents = path === "/admin/api/events";
      const isInfra = path === "/admin/api/infra";
      if (!isGraph && !isEvents && !isInfra && !runMatch) return false;

      const ctx = await deps.authenticate(req.headers.authorization);
      requireScope(ctx, deps.canonicalUri, "admin:view");

      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method_not_allowed" }, { allow: "GET" });
        return true;
      }

      if (isInfra) {
        sendJson(res, 200, deps.infra);
        return true;
      }

      if (isGraph) {
        const limitParam = url.searchParams.get("limit");
        let limit = DEFAULT_GRAPH_LIMIT;
        if (limitParam !== null) {
          limit = /^\d{1,6}$/.test(limitParam) ? Number(limitParam) : 0;
          if (limit < 1 || limit > MAX_GRAPH_LIMIT) {
            sendJson(res, 400, { error: "invalid_limit" });
            return true;
          }
        }
        const now = new Date();
        let since: Date;
        try {
          since = parseSince(url.searchParams.get("since"), now);
        } catch {
          sendJson(res, 400, { error: "invalid_since" });
          return true;
        }
        sendJson(res, 200, await loadGraph(deps.db, { since, limit, now, issueSites: deps.issueSites }));
        return true;
      }

      if (runMatch) {
        let id = "";
        try {
          id = decodeURIComponent(runMatch[1]);
        } catch {
          /* malformed escape: fails the id check below */
        }
        const detail = RUN_ID.test(id)
          ? await loadRunDetail(deps.db, id, deps.issueSites, ctx.providers.secrets)
          : null;
        if (!detail) sendJson(res, 404, { error: "not_found" });
        else sendJson(res, 200, detail);
        return true;
      }

      openStream(req, res);
      return true;
    },
    closeStreams() {
      for (const close of [...streams]) close();
    },
  };
}
