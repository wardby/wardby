import { afterEach, describe, expect, it } from "vitest";
import net, { type AddressInfo, type Socket } from "node:net";
import { once } from "node:events";
import { connectPinned } from "./safe-fetch.js";

function destination(port: number, address = "127.0.0.1") {
  // The hostname does not resolve anywhere: only the pinned address can be reached.
  return {
    url: new URL(`https://pinned.example.test:${port}/`),
    hostname: "pinned.example.test",
    address,
    family: net.isIP(address),
  };
}

describe("connectPinned", () => {
  const servers: net.Server[] = [];
  const sockets: Socket[] = [];

  async function listen(onConnection: (socket: Socket) => void): Promise<number> {
    const server = net.createServer(onConnection);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("connects to the pinned address and the URL's port, whatever the hostname resolves to", async () => {
    const port = await listen((socket) => socket.pipe(socket));
    const socket = await connectPinned(destination(port), new AbortController().signal);
    sockets.push(socket);
    socket.write("ping");
    const [chunk] = (await once(socket, "data")) as [Buffer];
    expect(chunk.toString()).toBe("ping");
    expect(socket.remoteAddress).toBe("127.0.0.1");
  });

  it("rejects when nothing listens at the pinned address", async () => {
    const port = await listen(() => undefined);
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));
    await expect(connectPinned(destination(port), new AbortController().signal)).rejects.toThrow();
  });

  it("rejects when the signal aborts before the connection is made", async () => {
    const port = await listen((socket) => socket.pipe(socket));
    const controller = new AbortController();
    controller.abort();
    await expect(connectPinned(destination(port), controller.signal)).rejects.toThrow();
  });

  it("keeps an established connection open when the signal aborts after connecting", async () => {
    const port = await listen((socket) => socket.pipe(socket));
    const controller = new AbortController();
    const socket = await connectPinned(destination(port), controller.signal);
    sockets.push(socket);
    // The tunnel's connect timeout firing later must not cut the tunnel: the caller closes it itself.
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.destroyed).toBe(false);
    socket.write("still here");
    const [chunk] = (await once(socket, "data")) as [Buffer];
    expect(chunk.toString()).toBe("still here");
  });

  it("outlives a timeout signal that fires after connecting", async () => {
    const port = await listen((socket) => socket.pipe(socket));
    const socket = await connectPinned(destination(port), AbortSignal.timeout(100));
    sockets.push(socket);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(socket.destroyed).toBe(false);
    socket.write("after timeout");
    const [chunk] = (await once(socket, "data")) as [Buffer];
    expect(chunk.toString()).toBe("after timeout");
  });

  it("rejects when the signal aborts while the connect is in progress", async () => {
    const port = await listen((socket) => socket.pipe(socket));
    const controller = new AbortController();
    const pending = connectPinned(destination(port), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
