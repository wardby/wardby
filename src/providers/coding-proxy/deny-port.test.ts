import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { startDenyPortListener } from "./deny-port.js";

/**
 * Connects once and reports whether the connect succeeded, how many bytes the server sent, and
 * whether *our own* client-side timeout was the thing that ended the connection. A server that
 * accepted and then held the connection open forever would still eventually produce a `close`
 * event here (once our timeout fires and we destroy the socket ourselves) — so `timedOut` is what
 * actually distinguishes "the server closed it" from "we gave up waiting"; a low timeout just
 * keeps that distinction cheap to observe.
 */
async function probe(port: number): Promise<{ connected: boolean; bytes: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 300 });
    let connected = false;
    let bytes = 0;
    let timedOut = false;
    socket.on("connect", () => {
      connected = true;
    });
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    socket.on("timeout", () => {
      timedOut = true;
      socket.destroy();
    });
    // The server destroys the socket, so the client sees ECONNRESET *after* connecting; only a
    // pre-connect error (e.g. ECONNREFUSED) is a real failure.
    socket.on("error", (error) => {
      if (!connected) reject(error);
    });
    socket.on("close", () => resolve({ connected, bytes, timedOut }));
  });
}

describe("deny-port listener", () => {
  it("accepts a connection, sends nothing, and closes it immediately", async () => {
    const listener = await startDenyPortListener("127.0.0.1", 0);
    try {
      // timedOut: false is the load-bearing assertion — it proves the server, not our own
      // client-side timeout, ended the connection; a server that held it open would report true.
      expect(await probe(listener.port)).toEqual({ connected: true, bytes: 0, timedOut: false });
    } finally {
      await listener.close();
    }
  });

  it("stops accepting once closed", async () => {
    const listener = await startDenyPortListener("127.0.0.1", 0);
    const { port } = listener;
    await listener.close();
    await expect(probe(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("rejects a port already in use rather than starting silently", async () => {
    const first = await startDenyPortListener("127.0.0.1", 0);
    try {
      await expect(startDenyPortListener("127.0.0.1", first.port)).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await first.close();
    }
  });
});
