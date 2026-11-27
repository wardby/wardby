import { describe, it, expect, afterEach } from "vitest";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "#prisma";
import { buildMcpServer } from "../server.js";
import { startHttpServer, type HttpServerHandle } from "./streamable-http.js";
import { createStdioLinkHost } from "./stdio-link-host.js";
import { setLogLineFilter } from "../../core/logger.js";
import { fakeResourceGrants } from "../../core/grants.test-support.js";
import { joinApiStdioRoutes } from "../tools/join-api.js";
import { JOIN_API_PATHS, type JoinLinkPayload } from "../tools/join-link.js";
import type { AuthProvider } from "../../providers/auth/types.js";

let handle: HttpServerHandle | undefined;
const logged: string[] = [];

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  setLogLineFilter((line) => line);
  logged.length = 0;
});

/** A run "r1" of agent "a1" (owner "owner"), running, that principal "g" may execute. */
function fakeDb(): PrismaClient {
  const run = {
    id: "r1",
    agentId: "a1",
    triggeredById: null,
    status: "running",
    costUsd: { toString: () => "0.010000" },
    error: null,
  };
  return {
    resourceGrant: fakeResourceGrants([
      { resourceType: "agent", resourceId: "a1", principalId: "g", level: "execute" },
    ]),
    agent: { findUnique: async () => ({ id: "a1", ownerId: "owner" }) },
    run: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === "r1" ? run : null) },
    codingRun: { findUnique: async () => ({ provider: "claude-code", workflowName: null, result: null }) },
    runStep: { findMany: async () => [] },
    authUser: { findUnique: async () => null },
    teamMember: { findMany: async () => [] },
  } as unknown as PrismaClient;
}

const payload = (aud: "http" | "stdio"): JoinLinkPayload => ({
  kind: "run-join",
  runId: "r1",
  principalId: "g",
  aud,
  exp: Date.now() + 60_000,
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function startHttp() {
  setLogLineFilter((line) => {
    logged.push(line);
    return line;
  });
  const port = await freePort();
  const canonicalUri = `http://127.0.0.1:${port}/mcp`;
  const db = fakeDb();
  const mcp = buildMcpServer({ providers: {} as never, db, config: { canonicalUri } });
  const providers = { runSteps: { record: async () => {} }, executor: { stop: async () => {} } } as never;
  handle = await startHttpServer({
    mcp,
    config: { canonicalUri, httpBind: { host: "127.0.0.1", port }, authProviderKind: "delegating" },
    auth: { authProvider: {} as AuthProvider, db, providers },
  });
  return { port, mcp, origin: `http://127.0.0.1:${port}` };
}

/** A raw POST, so the Host header can be set (fetch does not allow it). */
function post(port: number, path: string, opts: { auth?: string; host?: string; body?: string } = {}) {
  return new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.auth ? { authorization: opts.auth } : {}),
          ...(opts.host ? { host: opts.host } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += String(chunk)));
        res.on("end", () => {
          let json: Record<string, unknown>;
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            json = {};
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end(opts.body ?? "{}");
  });
}

describe("HTTP transport: join API route", () => {
  it("refuses a call without a Bearer token", async () => {
    const { port } = await startHttp();
    const answer = await post(port, JOIN_API_PATHS.status);
    expect(answer).toEqual({ status: 401, json: { error: "link_invalid" } });
  });

  it("answers a valid HTTP link with the run's status and a renewed token, and never logs the token", async () => {
    const { port, mcp } = await startHttp();
    const token = await mcp.mintRequestState(payload("http"));
    const answer = await post(port, JOIN_API_PATHS.status, { auth: `Bearer ${token}` });
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ runId: "r1", status: "running" });
    expect(typeof answer.json.token).toBe("string");
    expect(logged.join("\n")).not.toContain(token);
  });

  it("does not take the token from the query string", async () => {
    const { port, mcp } = await startHttp();
    const token = await mcp.mintRequestState(payload("http"));
    const answer = await post(port, `${JOIN_API_PATHS.status}?t=${encodeURIComponent(token)}`);
    expect(answer.status).not.toBe(200);
  });

  it("refuses a stdio link on the HTTP host", async () => {
    const { port, mcp } = await startHttp();
    const token = await mcp.mintRequestState(payload("stdio"));
    expect((await post(port, JOIN_API_PATHS.status, { auth: `Bearer ${token}` })).status).toBe(401);
  });

  it("refuses a request for another host (the canonical-Host check runs first)", async () => {
    const { port, mcp } = await startHttp();
    const token = await mcp.mintRequestState(payload("http"));
    const answer = await post(port, JOIN_API_PATHS.status, { auth: `Bearer ${token}`, host: "evil.example.com" });
    expect(answer.status).not.toBe(200);
    expect(answer.json.token).toBeUndefined();
  });
});

describe("stdio loopback host: join API routes", () => {
  it("serves the join API with the Bearer token and refuses without it", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: {} as never, db, config: { canonicalUri: "http://127.0.0.1/mcp" } });
    const host = createStdioLinkHost(
      joinApiStdioRoutes({
        verify: (t) => mcp.verifyRequestState(t),
        mint: (p) => mcp.mintRequestState(p),
        audience: "stdio",
        db: db,
        executor: { stop: async () => {} },
      }),
    );
    const origin = await host.origin();
    const port = Number(new URL(origin).port);
    const token = await mcp.mintRequestState(payload("stdio"));
    const ok = await post(port, JOIN_API_PATHS.status, { auth: `Bearer ${token}` });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ runId: "r1", status: "running" });
    expect((await post(port, JOIN_API_PATHS.status)).status).toBe(401);
    const httpLink = await mcp.mintRequestState(payload("http"));
    expect((await post(port, JOIN_API_PATHS.status, { auth: `Bearer ${httpLink}` })).status).toBe(401);
  });
});
