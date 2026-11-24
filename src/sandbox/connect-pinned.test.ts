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
});
