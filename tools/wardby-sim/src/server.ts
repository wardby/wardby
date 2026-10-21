// TEST ONLY (wardby-sim). One node:http (or https) server for every simulated service,
// routed by path prefix, with the control API at /__sim. Every service call is recorded
// (scheme only, never a credential) and passes the fault store first.
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { CONTROL_PREFIX, controlActions, handleControl } from "./control.js";
import { header, json, type SimRequest, type SimResponse } from "./http.js";
import type { SimService } from "./service.js";
import { authScheme, recordedBody, SimState } from "./state.js";

const MAX_BODY = 200 * 1024 * 1024;

export interface SimServerOptions {
  services: readonly SimService[];
  /** PEM key and certificate; without them the server speaks plain http. */
  tls?: { key: string | Buffer; cert: string | Buffer };
  state?: SimState;
}

export interface SimServer {
  server: Server;
  state: SimState;
  /** The base URL once listening ("http://127.0.0.1:43123"). */
  url: string;
  listen(port?: number, host?: string): Promise<string>;
  close(): Promise<void>;
  /** Runs one request without a socket (unit tests). */
  dispatch(req: SimRequest): Promise<SimResponse>;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function createSimServer(options: SimServerOptions): SimServer {
  const state = options.state ?? new SimState();
  // Longest prefix first, so "/github/api" wins over a shorter "/github".
  const services = [...options.services].sort((a, b) => b.prefix.length - a.prefix.length);
  const actions = controlActions(services);
  const init = (): void => {
    for (const service of services) service.init?.(state);
  };
  const reset = (): void => {
    state.reset();
    init();
  };
  init();

  async function dispatch(req: SimRequest): Promise<SimResponse> {
    if (req.fullPath === CONTROL_PREFIX || req.fullPath.startsWith(`${CONTROL_PREFIX}/`)) {
      return handleControl({ ...req, path: req.fullPath.slice(CONTROL_PREFIX.length) }, state, actions, reset);
    }
    const service = services.find(
      (candidate) => req.fullPath === candidate.prefix || req.fullPath.startsWith(`${candidate.prefix}/`),
    );
    const path = service ? req.fullPath.slice(service.prefix.length) || "/" : req.fullPath;
    const routed: SimRequest = { ...req, path };
    let principal: string | undefined;
    const fault = service ? state.faults.take(service.name, req.method, path) : undefined;
    let response: SimResponse;
    if (fault?.delayMs) await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    if (fault && !fault.passThrough) {
      response = fault.response;
    } else if (service) {
      try {
        response =
          (await service.handle(routed, { state, principal: (name) => (principal = name) })) ??
          json({ message: "Not Found", simulator: "no such route" }, 404);
      } catch (error) {
        response = json({ message: "simulator route failed", detail: (error as Error).message }, 500);
      }
    } else {
      response = json({ message: "Not Found", simulator: "no such service" }, 404);
    }
    state.calls.add({
      service: service?.name ?? "unknown",
      method: req.method,
      path,
      query: req.query.toString(),
      status: response.status,
      auth: authScheme(header(req, "authorization")),
      ...(principal ? { principal } : {}),
      ...(req.rawBody.length > 0 ? { body: recordedBody(req.rawBody, header(req, "content-type")) } : {}),
      ...(fault ? { faultId: fault.id } : {}),
    });
    return response;
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let response: SimResponse;
    try {
      const url = new URL(req.url ?? "/", "http://sim.invalid");
      const rawBody = await readBody(req);
      response = await dispatch({
        method: (req.method ?? "GET").toUpperCase(),
        fullPath: url.pathname,
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        rawBody,
      });
    } catch (error) {
      response = json({ message: "simulator failed", detail: (error as Error).message }, 500);
    }
    res.writeHead(response.status, response.headers ?? {});
    res.end(response.body);
  }

  const server = options.tls
    ? createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, (req, res) => void onRequest(req, res))
    : createHttpServer((req, res) => void onRequest(req, res));

  const sim: SimServer = {
    server,
    state,
    url: "",
    dispatch,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address() as AddressInfo;
          const shown = address.family === "IPv6" ? `[${address.address}]` : address.address;
          sim.url = `${options.tls ? "https" : "http"}://${shown}:${address.port}`;
          resolve(sim.url);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
  return sim;
}

/** A request for `dispatch` in unit tests. */
export function simRequest(
  method: string,
  pathAndQuery: string,
  body?: unknown,
  headers: Record<string, string> = {},
): SimRequest {
  const url = new URL(pathAndQuery, "http://sim.invalid");
  const rawBody =
    body === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return {
    method: method.toUpperCase(),
    fullPath: url.pathname,
    path: url.pathname,
    query: url.searchParams,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    rawBody,
  };
}
