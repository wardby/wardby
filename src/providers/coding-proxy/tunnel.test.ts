import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import { once } from "node:events";
import type { CodingTunnelConfig } from "../../config/coding-proxy-tunnel.js";
import { setLogLineFilter } from "../../core/logger.js";
import type { Resolver } from "../../sandbox/fetch-policy.js";
import type { connectPinned } from "../../sandbox/safe-fetch.js";
import {
  parseTarget,
  startTunnelListener,
  type TunnelAuditEvent,
  type TunnelListenerHandle,
  type TunnelListenerOptions,
} from "./tunnel.js";
import { InMemoryTunnelAuthenticator } from "./tunnel-auth.test-support.js";

const TOKEN = "fake-tunnel-token-SECRET-123";
const HOST = "registry.example.com";
const PUBLIC_ADDRESS = "93.184.216.34";

const publicResolver: Resolver = async () => [{ address: PUBLIC_ADDRESS, family: 4 }];

const baseConfig: CodingTunnelConfig = {
  port: 0,
  allowedHosts: [HOST, "ghcr.io"],
  maxConnections: 16,
  maxBytes: 1024 * 1024,
  idleMs: 5_000,
  maxDurationMs: 30_000,
};

function basic(token: string): string {
  return `Basic ${Buffer.from(`run:${token}`).toString("base64")}`;
}

interface Reply {
  status: number;
  head: string;
  body: string;
  code?: string;
  socket: Socket;
}

function parseReply(raw: string, socket: Socket): Reply {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const body = rest.join("\r\n\r\n");
  let code: string | undefined;
  try {
    code = (JSON.parse(body) as { error?: { type?: string } }).error?.type;
  } catch {
    code = undefined;
  }
  return { status: Number(head.slice(9, 12)), head, body, code, socket };
}

/** Sends a raw CONNECT. A 200 resolves as soon as the headers arrive, with the tunnel left open; anything else when the proxy closes. */
function openTunnel(port: number, target: string, authorization: string | null = basic(TOKEN)): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let raw = "";
    let settled = false;
    const onData = (chunk: Buffer) => {
      raw += chunk.toString("latin1");
      if (raw.startsWith("HTTP/1.1 200") && raw.includes("\r\n\r\n")) {
        socket.off("data", onData);
        settled = true;
        resolve(parseReply(raw, socket));
      }
    };
    socket.on("data", onData);
    socket.once("close", () => {
      settled = true;
      resolve(parseReply(raw, socket));
    });
    // A proxy that drops a tunnel can reset it; only a failure before the reply is the test's problem.
    socket.on("error", (error) => {
      if (!settled) reject(error);
    });
    socket.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
        `${authorization === null ? "" : `Proxy-Authorization: ${authorization}\r\n`}\r\n`,
    );
  });
}

/** Resolves when the socket is closed, whether it already is or not (a reset does not reject it). */
function closed(socket: Socket): Promise<void> {
  return socket.destroyed ? Promise.resolve() : new Promise((resolve) => socket.once("close", () => resolve()));
}

describe("coding proxy CONNECT tunnel", () => {
  let auth: InMemoryTunnelAuthenticator;
  let audits: TunnelAuditEvent[];
  let requests: Array<{ protocol: string; status: number; durationMs: number }>;
  let handles: TunnelListenerHandle[];
  let sockets: Socket[];
  let echo: net.Server;
  let echoPort: number;
  let connect: ReturnType<typeof vi.fn<typeof connectPinned>>;

  async function start(
    overrides: Partial<Omit<TunnelListenerOptions, "config">> & { config?: Partial<CodingTunnelConfig> } = {},
  ): Promise<TunnelListenerHandle> {
    const { config, ...rest } = overrides;
    const handle = await startTunnelListener({
      host: "127.0.0.1",
      config: { ...baseConfig, ...config },
      authenticator: auth,
      audit: (event) => audits.push(event),
      onRequest: (event) => requests.push(event),
      resolve: publicResolver,
      connect,
      ...rest,
    });
    handles.push(handle);
    return handle;
  }

  async function tunnel(port: number, target = `${HOST}:443`, authorization?: string | null): Promise<Reply> {
    const reply = await openTunnel(port, target, authorization);
    sockets.push(reply.socket);
    return reply;
  }

  beforeEach(async () => {
    auth = new InMemoryTunnelAuthenticator();
    auth.register(TOKEN, { runId: "run-1" });
    audits = [];
    requests = [];
    handles = [];
    sockets = [];
    echo = net.createServer((socket) => {
      // The proxy may destroy its side with data still in flight; that reset is not the echo server's failure.
      socket.on("error", () => undefined);
      socket.pipe(socket);
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    echoPort = (echo.address() as AddressInfo).port;
    // The vetted connection is replaced by one to the local echo server: no test reaches the internet.
    connect = vi.fn<typeof connectPinned>(
      () =>
        new Promise((resolve, reject) => {
          const socket = net.connect(echoPort, "127.0.0.1");
          socket.once("connect", () => resolve(socket));
          socket.once("error", reject);
        }),
    );
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    for (const handle of handles) await handle.close();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  });

  describe("listener and allowlist", () => {
    it("tunnels an allowed host on 443 and echoes both ways", async () => {
      const { port } = await start();
      const reply = await tunnel(port);
      expect(reply.status).toBe(200);
      reply.socket.write("hello");
      const [chunk] = (await once(reply.socket, "data")) as [Buffer];
      expect(chunk.toString()).toBe("hello");
    });

    it("matches the allowlist case-insensitively", async () => {
      const { port } = await start();
      expect((await tunnel(port, "REGISTRY.Example.COM:443")).status).toBe(200);
    });

    it("answers 407 with a challenge when there is no credential", async () => {
      const { port } = await start();
      const reply = await tunnel(port, `${HOST}:443`, null);
      expect(reply.status).toBe(407);
      expect(reply.code).toBe("tunnel_auth_required");
      expect(reply.head.toLowerCase()).toContain("proxy-authenticate: basic");
      expect(connect).not.toHaveBeenCalled();
    });

    it.each([
      ["a wrong token", basic("not-the-token")],
      ["an empty password", `Basic ${Buffer.from("run:").toString("base64")}`],
      ["a bearer scheme", `Bearer ${TOKEN}`],
      ["malformed base64", "Basic !!!"],
    ])("answers 407 for %s", async (_name, authorization) => {
      const { port } = await start();
      const reply = await tunnel(port, `${HOST}:443`, authorization);
      expect(reply.status).toBe(407);
      expect(reply.code).toBe("tunnel_auth_required");
      expect(connect).not.toHaveBeenCalled();
    });

    it("refuses a cancelled session and one past its deadline", async () => {
      auth.register("cancelled-token", { runId: "run-2" });
      auth.cancel("run-2");
      auth.register("expired-token", { runId: "run-3", deadlineAt: new Date(Date.now() - 1000) });
      const { port } = await start();
      for (const token of ["cancelled-token", "expired-token"]) {
        const reply = await tunnel(port, `${HOST}:443`, basic(token));
        expect(reply.status).toBe(403);
        expect(reply.code).toBe("tunnel_session_ended");
      }
    });

    it("refuses any port but 443", async () => {
      const { port } = await start();
      for (const target of [`${HOST}:80`, `${HOST}:8443`, `${HOST}:22`]) {
        const reply = await tunnel(port, target);
        expect(reply.status).toBe(403);
        expect(reply.code).toBe("tunnel_port_not_allowed");
      }
      expect(connect).not.toHaveBeenCalled();
    });

    it.each([
      ["an IPv4 literal", `${PUBLIC_ADDRESS}:443`],
      ["an IPv6 literal", "[2606:2800:220:1::1]:443"],
      ["a decimal IPv4 literal", "2130706433:443"],
      ["a loopback literal", "127.0.0.1:443"],
    ])("refuses %s", async (_name, target) => {
      const { port } = await start();
      const reply = await tunnel(port, target);
      expect(reply.status).toBe(403);
      expect(reply.code).toBe("tunnel_host_not_allowed");
      expect(connect).not.toHaveBeenCalled();
    });

    it("refuses a host that is not on the allowlist, and a subdomain of one that is", async () => {
      const { port } = await start();
      for (const target of ["evil.example.net:443", `sub.${HOST}:443`, `${HOST}.evil.example.net:443`]) {
        const reply = await tunnel(port, target);
        expect(reply.status).toBe(403);
        expect(reply.code).toBe("tunnel_host_not_allowed");
      }
      expect(connect).not.toHaveBeenCalled();
    });

    // Node's own parser may refuse some of these lines with a 400 before the handler runs; either way
    // nothing is tunnelled.
    it.each([HOST, `${HOST}:`, `${HOST}:abc`, `${HOST}:99999999`, ":443", `${"a".repeat(400)}:443`])(
      "answers 400 for the malformed target %j",
      async (target) => {
        const { port } = await start();
        const reply = await tunnel(port, target);
        expect(reply.status).toBe(400);
        expect(connect).not.toHaveBeenCalled();
      },
    );

    it.each([undefined, "", HOST, `${HOST}:`, `${HOST}:abc`, `${HOST}:443x`, `${HOST}:999999`, ":443", "a b:443"])(
      "parses %j as a bad target",
      (raw) => {
        expect(parseTarget(raw)).toEqual({ kind: "bad" });
      },
    );

    it("parses host:port, normalizing the host", () => {
      expect(parseTarget("Registry.Example.COM.:443")).toEqual({ kind: "ok", host: HOST, port: 443 });
      expect(parseTarget(`${HOST}:8443`)).toEqual({ kind: "ok", host: HOST, port: 8443 });
      expect(parseTarget("[2606:2800:220:1::1]:443")).toMatchObject({ kind: "ok", port: 443 });
    });

    it("refuses a plain http:// forward request with 405, never forwarding it", async () => {
      const { port } = await start();
      const reply = await new Promise<{ status: number; body: string; allow?: string }>((resolve, reject) => {
        const request = http.request(
          { host: "127.0.0.1", port, method: "GET", path: `http://${HOST}/v2/`, headers: { host: HOST } },
          (response) => {
            let body = "";
            response.on("data", (chunk: Buffer) => (body += chunk.toString()));
            response.on("end", () =>
              resolve({ status: response.statusCode ?? 0, body, allow: response.headers.allow }),
            );
          },
        );
        request.once("error", reject);
        request.end();
      });
      expect(reply.status).toBe(405);
      expect(reply.allow).toBe("CONNECT");
      expect(JSON.parse(reply.body)).toEqual({
        error: { type: "tunnel_connect_only", message: "tunnel_connect_only" },
      });
      expect(reply.body).not.toContain(HOST);
      expect(connect).not.toHaveBeenCalled();
    });
  });

  describe("destination check", () => {
    it("refuses a host that resolves to a private address", async () => {
      const { port } = await start({ resolve: async () => [{ address: "10.0.0.5", family: 4 }] });
      const reply = await tunnel(port);
      expect(reply.status).toBe(403);
      expect(reply.code).toBe("tunnel_destination_blocked");
      expect(connect).not.toHaveBeenCalled();
    });

    it.each(["127.0.0.1", "169.254.169.254", "::1", "fd00:ec2::254"])(
      "refuses a host that resolves to %s",
      async (address) => {
        const { port } = await start({
          resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
        });
        expect((await tunnel(port)).code).toBe("tunnel_destination_blocked");
        expect(connect).not.toHaveBeenCalled();
      },
    );

    it("refuses when any one of several resolved addresses is private", async () => {
      const { port } = await start({
        resolve: async () => [
          { address: PUBLIC_ADDRESS, family: 4 },
          { address: "192.168.1.10", family: 4 },
        ],
      });
      expect((await tunnel(port)).code).toBe("tunnel_destination_blocked");
    });

    it("connects to the address that was checked, with the allowed hostname", async () => {
      const { port } = await start();
      expect((await tunnel(port)).status).toBe(200);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: HOST, address: PUBLIC_ADDRESS, family: 4 }),
        expect.any(AbortSignal),
      );
    });

    it("answers 502 when the name does not resolve or the connection fails", async () => {
      const unresolved = await start({
        resolve: async () => {
          throw new Error("getaddrinfo ENOTFOUND");
        },
      });
      expect((await tunnel(unresolved.port)).code).toBe("tunnel_upstream_failed");

      connect.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
      const { port } = await start();
      const reply = await tunnel(port);
      expect(reply.status).toBe(502);
      expect(reply.code).toBe("tunnel_upstream_failed");
    });
  });

  describe("tunnel limits", () => {
    it("ends an idle tunnel", async () => {
      const { port } = await start({ config: { idleMs: 100 } });
      const reply = await tunnel(port);
      expect(reply.status).toBe(200);
      await closed(reply.socket);
      await vi.waitFor(() => expect(audits).toHaveLength(1));
      expect(audits[0].outcome).toBe("idle_timeout");
    });

    it("keeps a tunnel that is moving data past the idle timeout", async () => {
      const { port } = await start({ config: { idleMs: 300 } });
      const reply = await tunnel(port);
      for (let i = 0; i < 4; i++) {
        reply.socket.write("x");
        await once(reply.socket, "data");
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      expect(reply.socket.destroyed).toBe(false);
      expect(audits).toHaveLength(0);
    });

    it("ends a tunnel at the maximum duration, even while it is busy", async () => {
      const { port } = await start({ config: { idleMs: 5_000, maxDurationMs: 250 } });
      const reply = await tunnel(port);
      const timer = setInterval(() => reply.socket.write("x"), 20);
      try {
        await closed(reply.socket);
      } finally {
        clearInterval(timer);
      }
      await vi.waitFor(() => expect(audits).toHaveLength(1));
      expect(audits[0].outcome).toBe("max_duration");
    });

    it("ends a tunnel when its session deadline passes", async () => {
      auth.register("short-token", { runId: "run-short", deadlineAt: new Date(Date.now() + 300) });
      const { port } = await start();
      const reply = await tunnel(port, `${HOST}:443`, basic("short-token"));
      expect(reply.status).toBe(200);
      await closed(reply.socket);
      await vi.waitFor(() => expect(audits).toHaveLength(1));
      expect(audits[0]).toMatchObject({ runId: "run-short", outcome: "session_ended" });
    });

    it("ends a run's tunnels when its session is cancelled", async () => {
      const { port } = await start({ recheckMs: 30 });
      const reply = await tunnel(port);
      expect(reply.status).toBe(200);
      auth.cancel("run-1");
      await closed(reply.socket);
      await vi.waitFor(() => expect(audits).toHaveLength(1));
      expect(audits[0].outcome).toBe("session_ended");
    });

    it("caps open tunnels per run, per run only, and frees a slot when one closes", async () => {
      auth.register("other-token", { runId: "run-other" });
      const { port } = await start({ config: { maxConnections: 2 } });
      const first = await tunnel(port);
      const second = await tunnel(port);
      expect([first.status, second.status]).toEqual([200, 200]);

      const third = await tunnel(port);
      expect(third.status).toBe(429);
      expect(third.code).toBe("tunnel_limit");

      expect((await tunnel(port, `${HOST}:443`, basic("other-token"))).status).toBe(200);

      first.socket.destroy();
      await vi.waitFor(async () => expect((await tunnel(port)).status).toBe(200));
    });

    it("does not let concurrent CONNECTs slip past the cap", async () => {
      const { port } = await start({ config: { maxConnections: 2 } });
      const replies = await Promise.all(Array.from({ length: 6 }, () => tunnel(port)));
      expect(replies.filter((reply) => reply.status === 200)).toHaveLength(2);
      expect(replies.filter((reply) => reply.code === "tunnel_limit")).toHaveLength(4);
    });

    it("ends a tunnel that passes the run's byte cap and refuses the run's next one", async () => {
      const { port } = await start({ config: { maxBytes: 10 } });
      const reply = await tunnel(port);
      reply.socket.write("0123456789ABCDEF");
      await closed(reply.socket);
      await vi.waitFor(() => expect(audits).toHaveLength(1));
      expect(audits[0].outcome).toBe("byte_cap");

      const next = await tunnel(port);
      expect(next.status).toBe(429);
      expect(next.code).toBe("tunnel_limit");
    });

    it("counts bytes in both directions against the cap", async () => {
      const { port } = await start({ config: { maxBytes: 30 } });
      const reply = await tunnel(port);
      reply.socket.write("0123456789");
      await once(reply.socket, "data");
      expect(audits).toHaveLength(0);
      reply.socket.write("0123456789");
      reply.socket.write("0123456789");
      await closed(reply.socket);
      await vi.waitFor(() => expect(audits).toHaveLength(1));
      expect(audits[0].outcome).toBe("byte_cap");
    });

    it("ends open tunnels when the listener closes", async () => {
      const handle = await start();
      const reply = await tunnel(handle.port);
      await handle.close();
      await closed(reply.socket);
      expect(audits).toHaveLength(1);
      expect(audits[0].outcome).toBe("shutdown");
    });
  });

  describe("audit and metrics", () => {
    it("writes one record per tunnel with the run, host, bytes and outcome", async () => {
      const { port } = await start();
      const reply = await tunnel(port);
      reply.socket.write("hello");
      await once(reply.socket, "data");
      reply.socket.end();
      await closed(reply.socket);
      await vi.waitFor(() => expect(audits).toHaveLength(1));
      const [event] = audits;
      expect(event).toMatchObject({
        runId: "run-1",
        host: HOST,
        status: 200,
        outcome: "closed",
        bytesIn: 5,
        bytesOut: 5,
      });
      expect(event.startedAt).toBeInstanceOf(Date);
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(event).sort()).toEqual(
        ["bytesIn", "bytesOut", "durationMs", "host", "outcome", "runId", "startedAt", "status"].sort(),
      );
    });

    it("records a refusal for an authenticated run, and none when nobody authenticated", async () => {
      const { port } = await start();
      await tunnel(port, "evil.example.net:443");
      await tunnel(port, `${HOST}:8443`);
      await tunnel(port, `${HOST}:443`, null);
      await tunnel(port, `${HOST}:443`, basic("wrong"));
      expect(audits.map((event) => [event.runId, event.outcome, event.status])).toEqual([
        ["run-1", "tunnel_host_not_allowed", 403],
        ["run-1", "tunnel_port_not_allowed", 403],
      ]);
    });

    it("omits the host from a refusal for a host that is not on the allowlist", async () => {
      const { port } = await start();
      await tunnel(port, "fake-secret-host.evil.example.net:443");
      expect(audits).toHaveLength(1);
      expect(audits[0].host).toBeUndefined();
    });

    it("reports each answer to the metrics hook under the tunnel protocol", async () => {
      const { port } = await start();
      const ok = await tunnel(port);
      await tunnel(port, `${HOST}:443`, null);
      await tunnel(port, "evil.example.net:443");
      ok.socket.destroy();
      await vi.waitFor(() => expect(requests).toHaveLength(3));
      expect(requests.every((event) => event.protocol === "tunnel")).toBe(true);
      expect(requests.map((event) => event.status).sort()).toEqual([200, 403, 407]);
      expect(requests.every((event) => event.durationMs >= 0)).toBe(true);
    });

    it("survives a throwing audit sink and metrics hook", async () => {
      const { port } = await start({
        audit: () => {
          throw new Error("sink down");
        },
        onRequest: () => {
          throw new Error("metrics down");
        },
      });
      const reply = await tunnel(port);
      expect(reply.status).toBe(200);
      reply.socket.destroy();
      expect((await tunnel(port, "evil.example.net:443")).status).toBe(403);
    });
  });

  describe("secrets stay out of every output", () => {
    const hostileHost = "fake-secret-host-value.evil.example.net";

    it("never carries the token, the credential header or a refused host in a response, log, audit or metric", async () => {
      const lines: string[] = [];
      setLogLineFilter((line) => {
        lines.push(line);
        return line;
      });
      const replies: Reply[] = [];
      try {
        auth.register("cancelled-token", { runId: "run-2" });
        auth.cancel("run-2");
        const failing = await start({
          resolve: async () => {
            throw new Error(`lookup failed for ${TOKEN}`);
          },
        });
        const { port } = await start();
        const wrong = basic("wrong-fake-secret-456");
        const attempts: Array<[number, string, string | null]> = [
          [port, `${HOST}:443`, null],
          [port, `${HOST}:443`, wrong],
          [port, `${HOST}:443`, basic("cancelled-token")],
          [port, `${hostileHost}:443`, basic(TOKEN)],
          [port, `${HOST}:8443`, basic(TOKEN)],
          [port, "not-a-target", basic(TOKEN)],
          [port, `${PUBLIC_ADDRESS}:443`, basic(TOKEN)],
          [failing.port, `${HOST}:443`, basic(TOKEN)],
        ];
        for (const [target, host, authorization] of attempts) replies.push(await tunnel(target, host, authorization));
        const privateDns = await start({ resolve: async () => [{ address: "10.0.0.5", family: 4 }] });
        replies.push(await tunnel(privateDns.port, `${HOST}:443`, basic(TOKEN)));
        connect.mockRejectedValueOnce(new Error(`connect failed ${TOKEN}`));
        replies.push(await tunnel(port, `${HOST}:443`, basic(TOKEN)));
        const ok = await tunnel(port, `${HOST}:443`, basic(TOKEN));
        ok.socket.destroy();
        await vi.waitFor(() => expect(audits.length).toBeGreaterThanOrEqual(6));
      } finally {
        setLogLineFilter((line) => line);
      }
      expect(lines.length).toBeGreaterThan(0);
      const seen = JSON.stringify([replies.map((r) => [r.head, r.body]), audits, requests]) + lines.join("\n");
      for (const secret of [TOKEN, "wrong-fake-secret-456", "cancelled-token", basic(TOKEN), hostileHost]) {
        expect(seen).not.toContain(secret);
      }
      // The credential's base64 value never appears, whatever the token was.
      expect(seen).not.toContain(Buffer.from(`run:${TOKEN}`).toString("base64"));
    });

    it("answers with fixed JSON bodies only", async () => {
      const { port } = await start();
      for (const [target, authorization] of [
        [`${hostileHost}:443`, basic(TOKEN)],
        [`${HOST}:443`, null],
      ] as const) {
        const reply = await tunnel(port, target, authorization);
        const parsed = JSON.parse(reply.body) as { error: { type: string; message: string } };
        expect(parsed.error.type).toBe(parsed.error.message);
        expect(Object.keys(parsed)).toEqual(["error"]);
      }
    });
  });
});
