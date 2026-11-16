import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_PROBE_OUTSIDE_TARGETS } from "./protocol.js";
import { createEgressProbe, observeEgress, runNativeCanary, type EgressObservation } from "./substrate-canary.js";

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

describe("createEgressProbe", () => {
  const DENIAL = "403\nforbidden by egress policy";
  const http = (status: number, body: string): EgressObservation => ({ kind: "http", status, body });

  it("connection-level outcomes need no reference", async () => {
    const observe = vi.fn(async (host: string): Promise<EgressObservation> =>
      host === "10.0.0.1" ? { kind: "denied" } : { kind: "open" },
    );
    const connect = createEgressProbe({ observe });
    expect(await connect("10.0.0.1", 80)).toBe(false);
    expect(await connect("10.0.0.2", 80)).toBe(true);
    expect(observe.mock.calls.map((c) => c[0])).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("counts an HTTP answer equal to the reference denial (after naming the target) as denied", async () => {
    const observe = vi.fn(async (host: string, port: number): Promise<EgressObservation> => {
      if (host === "192.0.2.1") return http(403, `denied: 192.0.2.1:${port} is not allowed`);
      return http(403, `denied: ${host}:${port} is not allowed`);
    });
    const connect = createEgressProbe({ observe });
    expect(await connect("169.254.169.254", 80)).toBe(false);
    expect(await connect("169.254.170.23", 80)).toBe(false);
    // The reference is asked once per port.
    expect(observe.mock.calls.filter((c) => c[0] === "192.0.2.1")).toEqual([["192.0.2.1", 80]]);
  });

  it.each([
    ["a different status", http(200, "denied: <x> is not allowed")],
    ["a different body", http(403, '{"Code":"Success","Token":"metadata"}')],
  ])("counts %s from the target as reachable", async (_name, answer) => {
    const observe = async (host: string, port: number): Promise<EgressObservation> =>
      host === "192.0.2.1" ? http(403, `denied: 192.0.2.1:${port} is not allowed`) : answer;
    expect(await createEgressProbe({ observe })("169.254.169.254", 80)).toBe(true);
  });

  it.each([
    ["no answer at all", { kind: "denied" }],
    ["an open connection with no answer", { kind: "open" }],
  ])("counts any HTTP answer as reachable when the reference gives %s", async (_name, reference) => {
    const observe = async (host: string): Promise<EgressObservation> =>
      host === "192.0.2.1" ? reference : http(403, DENIAL);
    expect(await createEgressProbe({ observe })("1.1.1.1", 443)).toBe(true);
  });
});

describe("observeEgress", () => {
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

  it("is denied for a refused connection", async () => {
    const port = await listen(createNetServer());
    await new Promise((done) => servers.pop()?.close(done));
    expect(await observeEgress("127.0.0.1", port)).toEqual({ kind: "denied" });
  });

  it("is open for a connection that is accepted and then reset", async () => {
    const port = await listen(createNetServer((socket) => socket.destroy()));
    expect(await observeEgress("127.0.0.1", port)).toEqual({ kind: "open" });
  });

  it("is open for a connection that answers nothing in time", async () => {
    const port = await listen(createNetServer(() => {}));
    expect(await observeEgress("127.0.0.1", port, 100)).toEqual({ kind: "open" });
  });

  it("reads an HTTP answer's status and body", async () => {
    const port = await listen(
      createHttpServer((_req, res) => {
        res.writeHead(403);
        res.end("forbidden by egress policy");
      }),
    );
    expect(await observeEgress("127.0.0.1", port)).toEqual({
      kind: "http",
      status: 403,
      body: "forbidden by egress policy",
    });
  });
});
