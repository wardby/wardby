import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_PROBE_OUTSIDE_TARGETS } from "./protocol.js";
import { connectionOpens, runNativeCanary } from "./substrate-canary.js";

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
  it("passes when the gateway answers and everything else is denied, and posts with no credential", async () => {
    const { fetch, calls } = fakeFetch();
    const connect = vi.fn(reachable());
    expect(await runNativeCanary(GATEWAY_URL, ACTOR, { fetch, connect })).toBe("pass");
    const posts = calls.filter((c) => c.init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(CANARY_URL);
    expect(JSON.parse(posts[0].init?.body as string)).toEqual({ actor: ACTOR, result: "pass" });
    const headers = new Headers(posts[0].init?.headers);
    expect(headers.has("authorization")).toBe(false);
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

describe("connectionOpens (the default probe)", () => {
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
  const answering = (status: number, body: string) =>
    createHttpServer((_req, res) => {
      res.writeHead(status);
      res.end(body);
    });

  it("is denied only for a connection that never opens (refused)", async () => {
    const port = await listen(createNetServer());
    await new Promise((done) => servers.pop()?.close(done));
    expect(await connectionOpens("127.0.0.1", port)).toBe(false);
  });

  it.each([
    ["accepted and then dropped", () => createNetServer((socket) => socket.destroy())],
    ["accepted and silent", () => createNetServer(() => {})],
    ["answering 403 forbidden by egress policy", () => answering(403, "forbidden by egress policy")],
    ["answering 502 Bad Gateway", () => answering(502, "<html>502 Bad Gateway</html>")],
  ])("is reachable for a connection %s", async (_name, server) => {
    const port = await listen(server());
    expect(await connectionOpens("127.0.0.1", port, 500)).toBe(true);
  });

  it.each([
    ["accepts and drops", () => createNetServer((socket) => socket.destroy())],
    ["answers HTTP 502", () => answering(502, "<html>502 Bad Gateway</html>")],
    ["answers HTTP 403", () => answering(403, "forbidden by egress policy")],
  ])("fails the canary with deny_port_reachable when the deny port %s", async (_name, server) => {
    const denyPort = await listen(server());
    const { fetch } = (() => {
      const f = (async (url: string | URL) =>
        String(url).endsWith("/healthz")
          ? json({ ok: true })
          : new Response(null, { status: 204 })) as unknown as typeof globalThis.fetch;
      return { fetch: f };
    })();
    // The outside targets are not dialled for real here: only the gateway host is.
    const connect = (host: string, port: number) =>
      host === "127.0.0.1" ? connectionOpens(host, port, 500) : Promise.resolve(false);
    expect(
      await runNativeCanary("http://127.0.0.1:8790/native-gateway/v1/call", ACTOR, { fetch, connect, denyPort }),
    ).toBe("deny_port_reachable");
  });
});
