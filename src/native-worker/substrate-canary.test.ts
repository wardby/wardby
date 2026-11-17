import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_PLACEHOLDER_CAPABILITY, NATIVE_PROBE_OUTSIDE_TARGETS } from "./protocol.js";
import { startDenyPortListener } from "../providers/coding-proxy/deny-port.js";
import { EGRESS_DENIAL_MAX_BYTES, egressReachable, isEgressDenial, runNativeCanary } from "./substrate-canary.js";

const GATEWAY_URL = "http://wardby-native-gateway.wardby.svc.cluster.local:8790/native-gateway/v1/call";
const GATEWAY_HOST = "wardby-native-gateway.wardby.svc.cluster.local";
const CANARY_URL = "http://wardby-native-gateway.wardby.svc.cluster.local:8790/native-gateway/v1/canary";
const HEALTHZ_URL = "http://wardby-native-gateway.wardby.svc.cluster.local:8790/healthz";
const ACTOR = "wr-0123456789abcdef0123-canary";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake fetch: healthz answers `healthz()`, the canary route 204. Every request is recorded. */
function fakeFetch(healthz: () => Response | Promise<Response> = () => json({ ok: true })) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url) === HEALTHZ_URL) return healthz();
    return new Response(null, { status: 204 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

/** A connect that answers true only for the listed host:port pairs. */
const reachable =
  (...open: string[]) =>
  async (host: string, port: number) =>
    open.includes(`${host}:${port}`);

describe("runNativeCanary", () => {
  it("passes when the gateway answers and everything else is denied, and posts with the placeholder bearer", async () => {
    const { fetch, calls } = fakeFetch();
    const connect = vi.fn(reachable());
    expect(await runNativeCanary(GATEWAY_URL, ACTOR, { fetch, connect })).toBe("pass");
    const posts = calls.filter((c) => c.init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(CANARY_URL);
    expect(JSON.parse(posts[0].init?.body as string)).toEqual({ actor: ACTOR, result: "pass" });
    const headers = new Headers(posts[0].init?.headers);
    // Only the public placeholder: the egress gateway puts the canary's capability in its place.
    expect(headers.get("authorization")).toBe(`Bearer ${NATIVE_PLACEHOLDER_CAPABILITY}`);
    // The Kubernetes probe's targets: the deny port, then every outside address.
    expect(connect.mock.calls).toEqual([
      [GATEWAY_HOST, 8791],
      ...NATIVE_PROBE_OUTSIDE_TARGETS.map((t) => [t.host, t.port]),
    ]);
  });

  it.each([
    ["healthz 503", () => json({ ok: false }, 503)],
    ["healthz without ok", () => json({ ok: "yes" })],
    [
      "a thrown fetch",
      () => {
        throw new Error("connect ECONNREFUSED");
      },
    ],
  ])("reports gateway_unreachable for %s, and probes nothing else", async (_name, healthz) => {
    const { fetch, calls } = fakeFetch(healthz);
    const connect = vi.fn(reachable());
    expect(await runNativeCanary(GATEWAY_URL, ACTOR, { fetch, connect })).toBe("gateway_unreachable");
    expect(connect).not.toHaveBeenCalled();
    expect(JSON.parse(calls.at(-1)?.init?.body as string)).toEqual({ actor: ACTOR, result: "gateway_unreachable" });
  });

  it("reports gateway_unreachable, not a pass, when the gateway drops during the probes", async () => {
    let healthzCalls = 0;
    const { fetch } = fakeFetch(() => {
      healthzCalls += 1;
      return healthzCalls === 1 ? json({ ok: true }) : json({ ok: false }, 503);
    });
    expect(await runNativeCanary(GATEWAY_URL, ACTOR, { fetch, connect: reachable() })).toBe("gateway_unreachable");
    expect(healthzCalls).toBe(2);
  });

  it("reports deny_port_reachable when the gateway's deny port connects", async () => {
    const { fetch } = fakeFetch();
    const connect = reachable(`${GATEWAY_HOST}:8791`);
    expect(await runNativeCanary(GATEWAY_URL, ACTOR, { fetch, connect })).toBe("deny_port_reachable");
  });

  it("reports outside_reachable when a metadata endpoint connects", async () => {
    const { fetch } = fakeFetch();
    const connect = reachable("169.254.169.254:80");
    expect(await runNativeCanary(GATEWAY_URL, ACTOR, { fetch, connect })).toBe("outside_reachable");
  });

  it("reports the deny port first when both fail, as the Kubernetes probe", async () => {
    const { fetch } = fakeFetch();
    const connect = reachable(`${GATEWAY_HOST}:8791`, "169.254.169.254:80");
    expect(await runNativeCanary(GATEWAY_URL, ACTOR, { fetch, connect })).toBe("deny_port_reachable");
  });

  it("counts a probe that throws as reachable (fail closed)", async () => {
    const { fetch } = fakeFetch();
    const connect = async (host: string) => {
      if (host === "1.1.1.1") throw new Error("boom");
      return false;
    };
    expect(await runNativeCanary(GATEWAY_URL, ACTOR, { fetch, connect })).toBe("outside_reachable");
  });

  it("retries the report, then throws a fixed code when it cannot be posted", async () => {
    const calls: string[] = [];
    const fetch = (async (url: string | URL) => {
      calls.push(String(url));
      if (String(url) === HEALTHZ_URL) return json({ ok: true });
      return new Response(null, { status: 503 });
    }) as unknown as typeof globalThis.fetch;
    const sleep = vi.fn(async () => {});
    await expect(runNativeCanary(GATEWAY_URL, ACTOR, { fetch, connect: reachable(), sleep })).rejects.toThrow(
      /^native_substrate_canary_unreported$/,
    );
    expect(calls.filter((url) => url === CANARY_URL)).toHaveLength(3);
    expect(sleep.mock.calls).toEqual([[1000], [1000]]);
  });
});

describe("runNativeCanary deny port", () => {
  it("probes the configured deny port, not the default", async () => {
    const { fetch } = fakeFetch();
    const connect = vi.fn(reachable(`${GATEWAY_HOST}:8791`));
    expect(await runNativeCanary(GATEWAY_URL, ACTOR, { fetch, connect, denyPort: 9901 })).toBe("pass");
    expect(connect.mock.calls[0]).toEqual([GATEWAY_HOST, 9901]);
    expect(connect.mock.calls.some((c) => c[1] === 8791)).toBe(false);
    const open = reachable(`${GATEWAY_HOST}:9901`);
    expect(await runNativeCanary(GATEWAY_URL, ACTOR, { fetch, connect: open, denyPort: 9901 })).toBe(
      "deny_port_reachable",
    );
  });
});

/** The egress gateway's denial, byte for byte as the spike saw it, with `edit` applied. */
const DENIAL =
  "HTTP/1.1 403 Forbidden\r\ncontent-length: 13\r\ncontent-type: text/plain\r\nserver: envoy\r\nconnection: close\r\n\r\negress denied";

describe("isEgressDenial", () => {
  it("matches the egress gateway's denial exactly", () => {
    expect(isEgressDenial(Buffer.from(DENIAL), false)).toBe(true);
    expect(isEgressDenial(Buffer.from(DENIAL), true)).toBe(true);
    // Header names are case-insensitive; HTTP/1.0 is the same answer.
    expect(isEgressDenial(Buffer.from(DENIAL.replace("server:", "Server:")), true)).toBe(true);
    expect(isEgressDenial(Buffer.from(DENIAL.replace("HTTP/1.1", "HTTP/1.0")), true)).toBe(true);
  });

  it("matches a close-delimited denial only once the peer has closed", () => {
    const closeDelimited = DENIAL.replace("content-length: 13\r\n", "");
    expect(isEgressDenial(Buffer.from(closeDelimited), true)).toBe(true);
    expect(isEgressDenial(Buffer.from(closeDelimited), false)).toBe(false);
  });

  it.each([
    ["another status", DENIAL.replace("403 Forbidden", "404 Not Found")],
    ["status 4030", DENIAL.replace("403 Forbidden", "4030 Forbidden")],
    ["no server header", DENIAL.replace("server: envoy\r\n", "")],
    ["another server", DENIAL.replace("server: envoy", "server: nginx")],
    ["server envoy with more", DENIAL.replace("server: envoy", "server: envoy/1.30")],
    ["two server headers", DENIAL.replace("server: envoy", "server: envoy\r\nserver: envoy")],
    [
      "another body",
      DENIAL.replace("content-length: 13", "content-length: 15").replace("egress denied", "egress allowed!"),
    ],
    ["the body in another case", DENIAL.replace("egress denied", "Egress denied")],
    ["the body with a newline", DENIAL.replace("content-length: 13", "content-length: 14") + "\n"],
    ["more than the content-length", DENIAL + "x"],
    ["less than the content-length", DENIAL.slice(0, -1)],
    ["a content-length that is not the body's", DENIAL.replace("content-length: 13", "content-length: 12")],
    ["two content-lengths", DENIAL.replace("content-length: 13", "content-length: 13\r\ncontent-length: 13")],
    ["a chunked body", DENIAL.replace("content-length: 13", "transfer-encoding: chunked")],
    ["no blank line", DENIAL.replace("\r\n\r\n", "\r\n")],
    ["a header line with no colon", DENIAL.replace("connection: close", "connection close")],
    ["not HTTP", "SSH-2.0-OpenSSH_9.6\r\n\r\negress denied"],
    ["nothing", ""],
  ])("does not match %s", (_name, raw) => {
    expect(isEgressDenial(Buffer.from(raw), true)).toBe(false);
  });

  it("does not match an answer longer than it reads", () => {
    const padded = DENIAL.replace("server: envoy", `server: envoy\r\nx-pad: ${"a".repeat(EGRESS_DENIAL_MAX_BYTES)}`);
    expect(isEgressDenial(Buffer.from(padded), true)).toBe(false);
  });
});

describe("egressReachable (the default probe)", () => {
  const servers: (HttpServer | NetServer)[] = [];
  const sockets: Socket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  });
  const listen = async (server: HttpServer | NetServer): Promise<number> => {
    servers.push(server);
    server.on("connection", (socket: Socket) => sockets.push(socket));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return (server.address() as AddressInfo).port;
  };
  const answering = (status: number, body: string, headers: Record<string, string> = {}) =>
    createHttpServer((_req, res) => {
      res.writeHead(status, headers);
      res.end(body);
    });
  /** Writes `raw` as the whole answer once the request has arrived, then closes (or not). */
  const raw = (answer: string, close = true) =>
    createNetServer((socket) => {
      socket.once("data", () => {
        if (close) socket.end(answer);
        else socket.write(answer);
      });
    });

  it("is denied for a connection that never opens (refused)", async () => {
    const port = await listen(createNetServer());
    await new Promise((done) => servers.pop()?.close(done));
    expect(await egressReachable("127.0.0.1", port)).toBe(false);
  });

  it("is denied for the egress gateway's exact denial (by content-length, before any close)", async () => {
    expect(await egressReachable("127.0.0.1", await listen(raw(DENIAL)), 500)).toBe(false);
    expect(await egressReachable("127.0.0.1", await listen(raw(DENIAL, false)), 500)).toBe(false);
  });

  it("is denied for the denial from a real HTTP server (headers as Node writes them)", async () => {
    const headers = { server: "envoy", "content-type": "text/plain", "content-length": "13" };
    const port = await listen(answering(403, "egress denied", headers));
    expect(await egressReachable("127.0.0.1", port, 500)).toBe(false);
  });

  it("sends one GET with Connection: close and nothing else", async () => {
    let request = "";
    const port = await listen(
      createNetServer((socket) => {
        socket.on("data", (chunk) => {
          request += chunk.toString();
          if (request.includes("\r\n\r\n")) socket.end(DENIAL);
        });
      }),
    );
    expect(await egressReachable("127.0.0.1", port, 500)).toBe(false);
    expect(request).toBe(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  });

  it.each([
    ["accepted and then dropped", () => createNetServer((socket) => socket.destroy())],
    ["accepted and silent", () => createNetServer(() => {})],
    ["answering 403 forbidden by egress policy", () => answering(403, "forbidden by egress policy")],
    ["answering 502 Bad Gateway", () => answering(502, "<html>502 Bad Gateway</html>")],
    ["answering the denial's body with status 200", () => answering(200, "egress denied", { server: "envoy" })],
    ["answering the denial without server: envoy", () => answering(403, "egress denied")],
    ["answering the denial chunked", () => answering(403, "egress denied", { server: "envoy" })],
    ["answering the denial from another server", () => answering(403, "egress denied", { server: "nginx" })],
    ["answering 403 envoy with another body", () => answering(403, "egress denied.", { server: "envoy" })],
    ["answering the denial and more", () => raw(`${DENIAL}HTTP/1.1 200 OK\r\n\r\n`)],
    ["answering half the denial and going silent", () => raw(DENIAL.slice(0, 40), false)],
    [
      "answering a close-delimited denial and staying open",
      () => raw(DENIAL.replace("content-length: 13\r\n", ""), false),
    ],
    [
      "answering more than a probe reads",
      () => raw(`HTTP/1.1 403 Forbidden\r\nserver: envoy\r\n\r\n${"x".repeat(4096)}`),
    ],
  ])("is reachable for a connection %s", async (_name, server) => {
    const port = await listen(server());
    expect(await egressReachable("127.0.0.1", port, 500)).toBe(true);
  });

  it("is reachable against the gateway's real deny-port listener, which never answers the denial", async () => {
    const listener = await startDenyPortListener("127.0.0.1", 0);
    try {
      expect(await egressReachable("127.0.0.1", listener.port, 500)).toBe(true);
    } finally {
      await listener.close();
    }
  });

  it.each([
    ["accepts and drops", () => createNetServer((socket) => socket.destroy())],
    ["answers HTTP 502", () => answering(502, "<html>502 Bad Gateway</html>")],
    ["answers HTTP 403", () => answering(403, "forbidden by egress policy")],
  ])("fails the canary with deny_port_reachable when the deny port %s", async (_name, server) => {
    const denyPort = await listen(server());
    const fetch = (async (url: string | URL) =>
      String(url).endsWith("/healthz")
        ? json({ ok: true })
        : new Response(null, { status: 204 })) as unknown as typeof globalThis.fetch;
    // The outside targets are not dialled for real here: only the gateway host is.
    const connect = (host: string, port: number) =>
      host === "127.0.0.1" ? egressReachable(host, port, 500) : Promise.resolve(false);
    expect(
      await runNativeCanary("http://127.0.0.1:8790/native-gateway/v1/call", ACTOR, { fetch, connect, denyPort }),
    ).toBe("deny_port_reachable");
  });

  it("passes the canary when the deny port and the outside answer only the egress gateway's denial", async () => {
    const denyPort = await listen(raw(DENIAL));
    const fetch = (async (url: string | URL) =>
      String(url).endsWith("/healthz")
        ? json({ ok: true })
        : new Response(null, { status: 204 })) as unknown as typeof globalThis.fetch;
    const connect = (host: string, port: number) =>
      host === "127.0.0.1" ? egressReachable(host, port, 500) : egressReachable("127.0.0.1", denyPort, 500);
    expect(
      await runNativeCanary("http://127.0.0.1:8790/native-gateway/v1/call", ACTOR, { fetch, connect, denyPort }),
    ).toBe("pass");
  });
});
