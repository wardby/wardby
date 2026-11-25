// Loaded first: the certificate library needs it before it is imported.
import "reflect-metadata";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import net, { type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodingTunnelConfig } from "../../config/coding-proxy-tunnel.js";
import { setLogLineFilter } from "../../core/logger.js";
import type { Resolver } from "../../sandbox/fetch-policy.js";
import { startTunnelListener, type TunnelAuditEvent, type TunnelListenerHandle } from "./tunnel.js";
import { InMemoryTunnelAuthenticator } from "./tunnel-auth.test-support.js";
import { generateInterceptCa, loadInterceptCa } from "./tunnel-ca.js";
import {
  buildAuthorization,
  createInterceptor,
  forwardedHeaders,
  loadInterceptor,
  relayedHeaders,
  resolveInterceptRule,
  type Interceptor,
} from "./tunnel-intercept.js";
import { GcpTokenError } from "./gcp-access-token.js";

const TOKEN = "fake-tunnel-token-SECRET-123";
const CREDENTIAL = "FAKE-REGISTRY-CREDENTIAL-abc123";
const CLIENT_CREDENTIAL = "Bearer client-supplied-SECRET-789";
const HOST = "registry.example.com";
const BLIND_HOST = "ghcr.io";
const PUBLIC_ADDRESS = "93.184.216.34";
const publicResolver: Resolver = async () => [{ address: PUBLIC_ADDRESS, family: 4 }];

const config: CodingTunnelConfig = {
  port: 0,
  agentHosts: "off",
  allowedHosts: [HOST, BLIND_HOST],
  maxConnections: 16,
  maxBytes: 1024 * 1024,
  idleMs: 5_000,
  maxDurationMs: 30_000,
};

interface Seen {
  host: string;
  method: string;
  url: string;
  authorization?: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface Reply {
  status: number;
  headers: string;
  body: string;
}

/** A fake upstream registry: an HTTPS server whose certificate the intercepting proxy is told to trust. */
async function startUpstream(certificate: { certificatePem: string; privateKeyPem: string }, seen: Seen[]) {
  const server = createHttpsServer(
    { cert: certificate.certificatePem, key: certificate.privateKeyPem },
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          host: String(request.headers.host),
          method: request.method ?? "",
          url: request.url ?? "",
          authorization: request.headers.authorization,
          headers: request.headers,
          body: Buffer.concat(chunks).toString(),
        });
        if (request.url === "/redirect") {
          response.writeHead(302, { location: "https://other.example.com/blob" }).end();
        } else if (request.url === "/fail") {
          request.socket.destroy();
        } else if (request.url === "/big") {
          response.writeHead(200).end(Buffer.alloc(2 * 1024 * 1024, 97));
        } else {
          response.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
          response.end(JSON.stringify({ ok: true, echoed: Buffer.concat(chunks).toString() }));
        }
      });
    },
  );
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function basic(token: string): string {
  return `Basic ${Buffer.from(`run:${token}`).toString("base64")}`;
}

/** CONNECT through the tunnel; resolves with the open socket on 200 and with the refusal otherwise. */
function connectTunnel(port: number, target: string): Promise<{ status: number; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let raw = "";
    socket.on("data", function onData(chunk: Buffer) {
      raw += chunk.toString("latin1");
      if (!raw.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve({ status: Number(raw.slice(9, 12)), socket });
    });
    socket.on("error", reject);
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${basic(TOKEN)}\r\n\r\n`);
  });
}

/** A chunked body decoded; any other body as it came. */
function decode(headers: string, body: string): string {
  if (!/transfer-encoding: chunked/i.test(headers)) return body;
  let out = "";
  for (let rest = body; ;) {
    const lineEnd = rest.indexOf("\r\n");
    const size = Number.parseInt(rest.slice(0, lineEnd), 16);
    if (lineEnd < 0 || !Number.isFinite(size) || size === 0) return out;
    out += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
}

/** One request over the run's TLS, which trusts only the proxy's CA. */
function request(secure: TLSSocket, lines: string[], body = ""): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let raw = "";
    secure.on("data", (chunk: Buffer) => (raw += chunk.toString("latin1")));
    secure.once("error", reject);
    secure.once("close", () => {
      const [headers, ...rest] = raw.split("\r\n\r\n");
      resolve({ status: Number(headers.slice(9, 12)), headers, body: decode(headers, rest.join("\r\n\r\n")) });
    });
    secure.write(`${lines.join("\r\n")}\r\n\r\n${body}`);
  });
}

describe("tunnel TLS interception", () => {
  let auth: InMemoryTunnelAuthenticator;
  let audits: TunnelAuditEvent[];
  let handles: TunnelListenerHandle[];
  let sockets: Socket[];
  let upstream: HttpsServer;
  let blind: net.Server;
  let seen: Seen[];
  let blindConnections: number;
  let runCaPem: string;
  let runCaPair: Awaited<ReturnType<typeof generateInterceptCa>>;
  let upstreamCaPem: string;
  let interceptor: Interceptor;

  async function start(overrides: Partial<CodingTunnelConfig> = {}): Promise<TunnelListenerHandle> {
    const handle = await startTunnelListener({
      host: "127.0.0.1",
      config: { ...config, ...overrides },
      authenticator: auth,
      interceptor,
      audit: (event) => audits.push(event),
      resolve: publicResolver,
      // The vetted connection goes to the local fake: the intercepted host to the fake registry, the other to a plain listener.
      connect: async (destination) => {
        const port =
          destination.hostname === HOST
            ? (upstream.address() as AddressInfo).port
            : (blind.address() as AddressInfo).port;
        const socket = net.connect(port, "127.0.0.1");
        await once(socket, "connect");
        return socket;
      },
    });
    handles.push(handle);
    return handle;
  }

  /** A run's TLS to the intercepted host, through the tunnel, trusting only the proxy's CA. */
  async function secureTo(
    port: number,
    servername: string | null = HOST,
    trust = runCaPem,
    verify = true,
  ): Promise<TLSSocket> {
    const { status, socket } = await connectTunnel(port, `${HOST}:443`);
    expect(status).toBe(200);
    sockets.push(socket);
    const secure = tlsConnect({
      socket,
      ...(servername === null ? {} : { servername }),
      ca: trust,
      rejectUnauthorized: verify,
    });
    secure.on("error", () => undefined);
    return secure;
  }

  beforeEach(async () => {
    auth = new InMemoryTunnelAuthenticator();
    auth.register(TOKEN, { runId: "run-1" });
    audits = [];
    handles = [];
    sockets = [];
    seen = [];
    blindConnections = 0;
    const upstreamCa = await generateInterceptCa({ hosts: [HOST] });
    upstreamCaPem = upstreamCa.certificatePem;
    const upstreamLeaf = await (await loadInterceptCa({ ...upstreamCa, hosts: [HOST] })).leafFor(HOST);
    upstream = await startUpstream(upstreamLeaf, seen);
    blind = net.createServer((socket) => {
      blindConnections++;
      socket.on("error", () => undefined);
      socket.end();
    });
    await new Promise<void>((resolve) => blind.listen(0, "127.0.0.1", resolve));
    const runCa = await generateInterceptCa({ hosts: [HOST] });
    runCaPem = runCa.certificatePem;
    runCaPair = runCa;
    interceptor = createInterceptor({
      ca: await loadInterceptCa({ ...runCa, hosts: [HOST] }),
      rules: [{ host: HOST, authorization: `Bearer ${CREDENTIAL}` }],
      allowedHosts: config.allowedHosts,
      resolve: publicResolver,
      connect: async () => {
        const socket = net.connect((upstream.address() as AddressInfo).port, "127.0.0.1");
        await once(socket, "connect");
        return socket;
      },
      upstreamTls: { ca: upstreamCa.certificatePem },
    });
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(handles.map((handle) => handle.close()));
    upstream.closeAllConnections();
    upstream.close();
    blind.close();
  });

  it("attaches the credential, drops the client's own, and relays the body and response", async () => {
    const { port } = await start();
    const secure = await secureTo(port);
    const body = '{"layer":"sha256:abc"}';
    const reply = await request(
      secure,
      [
        "POST /v2/library/app/blobs/uploads/ HTTP/1.1",
        `Host: ${HOST}`,
        `Authorization: ${CLIENT_CREDENTIAL}`,
        "Proxy-Authorization: Basic Zm9vOmJhcg==",
        "X-Forwarded-For: 10.0.0.9",
        "Content-Type: application/json",
        `Content-Length: ${body.length}`,
        "Connection: close",
      ],
      body,
    );
    expect(reply.status).toBe(200);
    expect(reply.headers.toLowerCase()).toContain("x-upstream: yes");
    expect(JSON.parse(reply.body)).toEqual({ ok: true, echoed: body });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "/v2/library/app/blobs/uploads/",
      host: HOST,
      authorization: `Bearer ${CREDENTIAL}`,
      body,
    });
    expect(seen[0].headers["proxy-authorization"]).toBeUndefined();
    expect(seen[0].headers["x-forwarded-for"]).toBeUndefined();
    expect(JSON.stringify(seen[0].headers)).not.toContain("client-supplied");
  });

  it("attaches a gcp rule's token from its source on each request, and refuses only the request it fails for", async () => {
    let calls = 0;
    let fail = false;
    const source = async () => {
      calls++;
      if (fail) throw new GcpTokenError("metadata_http_403");
      return `Bearer gcp-token-${calls}`;
    };
    interceptor = createInterceptor({
      ca: await loadInterceptCa({ ...runCaPair, hosts: [HOST] }),
      rules: [{ host: HOST, authorization: source }],
      allowedHosts: config.allowedHosts,
      resolve: publicResolver,
      connect: async () => {
        const socket = net.connect((upstream.address() as AddressInfo).port, "127.0.0.1");
        await once(socket, "connect");
        return socket;
      },
      upstreamTls: { ca: upstreamCaPem },
    });
    const { port } = await start();
    const ask = async () =>
      request(await secureTo(port), [
        "GET /v2/ HTTP/1.1",
        `Host: ${HOST}`,
        `Authorization: ${CLIENT_CREDENTIAL}`,
        "Connection: close",
      ]);
    expect((await ask()).status).toBe(200);
    expect(seen[0].authorization).toBe("Bearer gcp-token-1");
    fail = true;
    const refused = await ask();
    expect(refused.status).toBe(502);
    expect(refused.body).toContain("intercept_upstream_failed");
    expect(refused.body).not.toContain("gcp-token");
    // The refused request never reached the registry.
    expect(seen).toHaveLength(1);
  });

  it("serves several requests on one tunnel and reports them in the audit record", async () => {
    const { port } = await start();
    const secure = await secureTo(port);
    const first = await new Promise<string>((resolve) => {
      let raw = "";
      secure.on("data", (chunk: Buffer) => {
        raw += chunk.toString("latin1");
        if (raw.includes('"ok":true')) resolve(raw);
      });
      secure.write(`GET /v2/ HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`);
    });
    expect(first).toContain("200");
    secure.write(`GET /v2/_catalog HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`);
    await once(secure, "close");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.map((entry) => entry.url)).toEqual(["/v2/", "/v2/_catalog"]);
    expect(seen.every((entry) => entry.authorization === `Bearer ${CREDENTIAL}`)).toBe(true);
    await handles[0].close();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ host: HOST, status: 200, intercepted: { requests: 2 } });
  });

  it("refuses a TLS client whose server name is missing or is not the tunnelled host", async () => {
    const { port } = await start();
    for (const servername of ["other.example.com", null]) {
      // The client skips certificate checks, so only the proxy's own check on the server name can refuse it.
      const secure = await secureTo(port, servername, runCaPem, false);
      const outcome = await new Promise<"accepted" | "refused">((resolve) => {
        secure.once("secureConnect", () => resolve("accepted"));
        secure.once("close", () => resolve("refused"));
      });
      expect(outcome).toBe("refused");
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses a request whose Host header names another host, an absolute-form target or an upgrade", async () => {
    const { port } = await start();
    const attempts: string[][] = [
      ["GET /v2/ HTTP/1.1", "Host: other.example.com", "Connection: close"],
      [`GET https://other.example.com/v2/ HTTP/1.1`, `Host: ${HOST}`, "Connection: close"],
      ["GET /v2/ HTTP/1.1", `Host: ${HOST}`, "Upgrade: websocket", "Connection: Upgrade"],
    ];
    for (const lines of attempts) {
      const reply = await request(await secureTo(port), lines);
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body)).toEqual({
        error: { type: "intercept_bad_request", message: "intercept_bad_request" },
      });
    }
    expect(seen).toHaveLength(0);
  });

  it("relays a redirect without following it, so the credential goes to no other host", async () => {
    const { port } = await start();
    const reply = await request(await secureTo(port), ["GET /redirect HTTP/1.1", `Host: ${HOST}`, "Connection: close"]);
    expect(reply.status).toBe(302);
    expect(reply.headers.toLowerCase()).toContain("location: https://other.example.com/blob");
    expect(seen).toHaveLength(1);
    expect(blindConnections).toBe(0);
  });

  it("answers an upstream failure with a fixed code", async () => {
    const { port } = await start();
    const reply = await request(await secureTo(port), ["GET /fail HTTP/1.1", `Host: ${HOST}`, "Connection: close"]);
    expect(reply.status).toBe(502);
    expect(JSON.parse(reply.body)).toEqual({
      error: { type: "intercept_upstream_failed", message: "intercept_upstream_failed" },
    });
  });

  it("refuses when the destination is not public, before any credential is attached", async () => {
    const privateCa = await generateInterceptCa({ hosts: [HOST] });
    const guarded = await startTunnelListener({
      host: "127.0.0.1",
      config,
      authenticator: auth,
      interceptor: createInterceptor({
        ca: await loadInterceptCa({ ...privateCa, hosts: [HOST] }),
        rules: [{ host: HOST, authorization: `Bearer ${CREDENTIAL}` }],
        allowedHosts: config.allowedHosts,
        resolve: async () => [{ address: "10.0.0.5", family: 4 }],
      }),
      audit: (event) => audits.push(event),
    });
    handles.push(guarded);
    const reply = await request(await secureTo(guarded.port, HOST, privateCa.certificatePem), [
      "GET /v2/ HTTP/1.1",
      `Host: ${HOST}`,
      "Connection: close",
    ]);
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body)).toEqual({
      error: { type: "intercept_destination_blocked", message: "intercept_destination_blocked" },
    });
    expect(seen).toHaveLength(0);
  });

  it("leaves every other allowed host a blind tunnel that never carries the credential", async () => {
    const { port } = await start();
    const { status, socket } = await connectTunnel(port, `${BLIND_HOST}:443`);
    sockets.push(socket);
    expect(status).toBe(200);
    await once(socket, "close");
    expect(blindConnections).toBe(1);
    expect(seen).toHaveLength(0);
  });

  it("ends the tunnel when the run's byte cap is passed", async () => {
    const { port } = await start({ maxBytes: 64 * 1024 });
    const secure = await secureTo(port);
    // Drained: a stream with unread data never reaches end, so it would never close.
    secure.resume();
    secure.write(`GET /big HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`);
    await once(secure, "close");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await handles[0].close();
    expect(audits[0]).toMatchObject({ outcome: "byte_cap", intercepted: { requests: 1 } });
  });

  it("never carries the credential, a client header or a path in a response, log or audit record", async () => {
    const lines: string[] = [];
    setLogLineFilter((line) => {
      lines.push(line);
      return line;
    });
    const replies: Reply[] = [];
    try {
      const { port } = await start();
      for (const target of ["/fail", "/redirect", "/v2/secret-path-xyz"]) {
        replies.push(
          await request(await secureTo(port), [
            `GET ${target} HTTP/1.1`,
            `Host: ${HOST}`,
            `Authorization: ${CLIENT_CREDENTIAL}`,
            "Connection: close",
          ]),
        );
      }
      replies.push(
        await request(await secureTo(port), ["GET /v2/ HTTP/1.1", "Host: wrong.example.com", "Connection: close"]),
      );
      await handles[0].close();
    } finally {
      setLogLineFilter((line) => line);
    }
    expect(lines.length).toBeGreaterThan(0);
    const observed = JSON.stringify([replies.map((reply) => [reply.headers, reply.body]), audits]) + lines.join("\n");
    for (const secret of [
      CREDENTIAL,
      "client-supplied",
      Buffer.from(CREDENTIAL).toString("base64"),
      "secret-path-xyz",
    ]) {
      expect(observed).not.toContain(secret);
    }
  });
});

describe("relayed header lists", () => {
  // JSON.parse makes "__proto__" an own property, as a peer's header name could be.
  const hostile = (): Record<string, string | string[]> =>
    JSON.parse('{"__proto__":["polluted"],"constructor":"x","x-keep":"1","set-cookie":["a=1","b=2"]}');

  it("drops a __proto__ header and keeps one named like another Object property as a plain header", () => {
    const out = relayedHeaders(hostile());
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual(["constructor", "x", "x-keep", "1", "set-cookie", "a=1", "set-cookie", "b=2"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Array.prototype);
  });

  it("drops a name that is not a well-formed HTTP field name, in both directions", () => {
    const odd = { "bad name": "1", "x\r\ny": "2", "": "3", "x:y": "4", "ok-name": "5" };
    expect(relayedHeaders(odd)).toEqual(["ok-name", "5"]);
    expect(forwardedHeaders(odd, HOST, "Bearer proxy-credential").slice(0, 2)).toEqual(["ok-name", "5"]);
  });

  it("drops hop-by-hop response headers", () => {
    expect(
      relayedHeaders({ connection: "close", "transfer-encoding": "chunked", "content-type": "text/plain" }),
    ).toEqual(["content-type", "text/plain"]);
  });

  it("replaces the client's Host and Authorization, and drops its proxy and forwarding headers", () => {
    const out = forwardedHeaders(
      {
        ...hostile(),
        host: "evil.example",
        authorization: CLIENT_CREDENTIAL,
        "x-forwarded-for": "1.2.3.4",
        via: "1.1 x",
      },
      HOST,
      "Bearer proxy-credential",
    );
    expect(out.slice(-4)).toEqual(["host", HOST, "authorization", "Bearer proxy-credential"]);
    expect(out.filter((entry) => entry.toLowerCase() === "host")).toHaveLength(1);
    expect(out.join("\n")).not.toContain("evil.example");
    expect(out.join("\n")).not.toContain("client-supplied");
    expect(out).not.toContain("x-forwarded-for");
    expect(out).not.toContain("via");
    expect(out).not.toContain("__proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("loadInterceptor", () => {
  let directory: string;
  let certFile: string;
  let keyFile: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "intercept-ca-"));
    const ca = await generateInterceptCa({ hosts: [HOST] });
    certFile = join(directory, "ca.crt");
    keyFile = join(directory, "ca.key");
    await writeFile(certFile, ca.certificatePem);
    await writeFile(keyFile, ca.privateKeyPem);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const withIntercept = (
    rule: Record<string, string>,
    files = { caCertFile: certFile, caKeyFile: keyFile },
  ): CodingTunnelConfig => ({
    ...config,
    intercept: { rules: [{ host: HOST, scheme: "bearer", credential: "env:FAKE_CRED", ...rule } as never], ...files },
  });

  it("is off when no host is intercepted", async () => {
    expect(await loadInterceptor(config, {})).toBeUndefined();
  });

  it("builds the interceptor for the rules' hosts", async () => {
    const loaded = await loadInterceptor(withIntercept({}), { FAKE_CRED: CREDENTIAL });
    expect([...(loaded?.hosts ?? [])]).toEqual([HOST]);
  });

  it("names the variable, never the value, when a credential is unset or malformed", async () => {
    await expect(loadInterceptor(withIntercept({}), {})).rejects.toThrow("FAKE_CRED, which is not set");
    const bad = "line one\r\nInjected: header";
    const error = await loadInterceptor(withIntercept({}), { FAKE_CRED: bad }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("FAKE_CRED must be one line of printable characters.");
    expect((error as Error).message).not.toContain("Injected");
  });

  it("takes the CA as PEM text from the environment, a multi-line value intact", async () => {
    const [caCertPem, caKeyPem] = [await readFile(certFile, "utf8"), await readFile(keyFile, "utf8")];
    expect(caCertPem.split("\n").length).toBeGreaterThan(3);
    const inline = {
      ...config,
      intercept: {
        rules: [{ host: HOST, scheme: "bearer", credential: "env:FAKE_CRED" } as never],
        caCertPem,
        caKeyPem,
      },
    };
    const loaded = await loadInterceptor(inline, { FAKE_CRED: CREDENTIAL });
    expect([...(loaded?.hosts ?? [])]).toEqual([HOST]);
  });

  it("refuses PEM text that is not a CA or key, without echoing it", async () => {
    const marker = "fake-secret-pem-123";
    const caCertPem = `-----BEGIN CERTIFICATE-----\n${marker}\n-----END CERTIFICATE-----\n`;
    const caKeyPem = `-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----\n`;
    const inline = {
      ...config,
      intercept: {
        rules: [{ host: HOST, scheme: "bearer", credential: "env:FAKE_CRED" } as never],
        caCertPem,
        caKeyPem,
      },
    };
    const error = await loadInterceptor(inline, { FAKE_CRED: CREDENTIAL }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("The intercept CA certificate could not be read.");
    const [goodCert] = [await readFile(certFile, "utf8")];
    const keyOnly = { ...inline, intercept: { ...inline.intercept, caCertPem: goodCert } };
    const keyError = await loadInterceptor(keyOnly, { FAKE_CRED: CREDENTIAL }).catch((caught: unknown) => caught);
    expect((keyError as Error).message).toBe("The intercept CA key could not be read.");
    expect((keyError as Error).message).not.toContain(marker);
  });

  it("refuses an unreadable CA or one that does not cover the host, without echoing a path or key", async () => {
    const missing = withIntercept({}, { caCertFile: join(directory, "missing.crt"), caKeyFile: keyFile });
    const unreadable = await loadInterceptor(missing, { FAKE_CRED: CREDENTIAL }).catch((caught: unknown) => caught);
    expect((unreadable as Error).message).toBe(
      "CODING_TUNNEL_INTERCEPT_CA_CERT_FILE and _KEY_FILE must be readable files.",
    );
    expect((unreadable as Error).message).not.toContain(directory);
    const other = await generateInterceptCa({ hosts: ["elsewhere.example.com"] });
    await writeFile(certFile, other.certificatePem);
    await writeFile(keyFile, other.privateKeyPem);
    await expect(loadInterceptor(withIntercept({}), { FAKE_CRED: CREDENTIAL })).rejects.toThrow(
      "name constraint must permit",
    );
  });

  describe("resolveInterceptRule", () => {
    const basic = { host: HOST, scheme: "basic", credential: "env:FAKE_TOKEN" } as const;
    const header = (user: string) => `Basic ${Buffer.from(`${user}:${CREDENTIAL}`).toString("base64")}`;

    it("reads a Basic user name from an environment variable, like the registry proxy's pair", () => {
      const rule = { ...basic, usernameCredential: "env:FAKE_USER" } as const;
      expect(resolveInterceptRule(rule, { FAKE_TOKEN: CREDENTIAL, FAKE_USER: "jane@example.com" })).toEqual({
        host: HOST,
        authorization: header("jane@example.com"),
      });
    });

    it("hands a gcp rule the token source, reading nothing from the environment", () => {
      const source = async () => "Bearer t";
      expect(resolveInterceptRule({ host: HOST, scheme: "gcp" }, {}, source)).toEqual({
        host: HOST,
        authorization: source,
      });
    });

    it("uses a written-out user name, and a token alone for Bearer", () => {
      const env = { FAKE_TOKEN: CREDENTIAL };
      expect(resolveInterceptRule({ ...basic, username: "jane" }, env).authorization).toBe(header("jane"));
      expect(resolveInterceptRule({ host: HOST, scheme: "bearer", credential: "env:FAKE_TOKEN" }, env)).toEqual({
        host: HOST,
        authorization: `Bearer ${CREDENTIAL}`,
      });
    });

    it("names the variable, never the value, when the user name is unset or unusable", () => {
      const rule = { ...basic, usernameCredential: "env:FAKE_USER" } as const;
      expect(() => resolveInterceptRule(rule, { FAKE_TOKEN: CREDENTIAL })).toThrow("FAKE_USER, which is not set");
      const bad = "secret-user:with-colon";
      let message = "";
      try {
        resolveInterceptRule(rule, { FAKE_TOKEN: CREDENTIAL, FAKE_USER: bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("FAKE_USER must be a user name of printable characters without a colon.");
      expect(message).not.toContain("secret-user");
    });
  });

  it("builds a Bearer or a Basic header value", () => {
    expect(buildAuthorization("bearer", undefined, CREDENTIAL)).toBe(`Bearer ${CREDENTIAL}`);
    expect(buildAuthorization("basic", "oauth2accesstoken", CREDENTIAL)).toBe(
      `Basic ${Buffer.from(`oauth2accesstoken:${CREDENTIAL}`).toString("base64")}`,
    );
  });
});
