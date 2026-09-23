import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { startDenyPortListener } from "./deny-port.js";

/** Connects once and reports whether the connect succeeded and how many bytes the server sent. */
async function probe(port: number): Promise<{ connected: boolean; bytes: number }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 3000 });
    let connected = false;
    let bytes = 0;
    socket.on("connect", () => {
      connected = true;
    });
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    socket.on("timeout", () => socket.destroy());
    // The server destroys the socket, so the client sees ECONNRESET *after* connecting; only a
    // pre-connect error (e.g. ECONNREFUSED) is a real failure.
    socket.on("error", (error) => {
      if (!connected) reject(error);
    });
    socket.on("close", () => resolve({ connected, bytes }));
  });
}

describe("deny-port listener", () => {
  it("accepts a connection, sends nothing, and closes it immediately", async () => {
    const listener = await startDenyPortListener("127.0.0.1", 0);
    try {
      expect(await probe(listener.port)).toEqual({ connected: true, bytes: 0 });
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
