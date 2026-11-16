import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_EXPORT_BYTES } from "./exports.js";
import { createRendererClient } from "./renderer-client.js";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

type Seen = { path?: string; body?: string; type?: string };
async function stub(handler: (req: IncomingMessage, res: ServerResponse) => void, seen: Seen = {}): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.path = req.url;
      seen.type = req.headers["content-type"];
      seen.body = Buffer.concat(chunks).toString("utf8");
      handler(req, res);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("createRendererClient", () => {
  it("POSTs JSON to /v1/png and /v1/pdf and returns the bytes", async () => {
    const seen: Seen = {};
    const url = await stub((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([1, 2, 3]));
    }, seen);
    const client = createRendererClient(url);
    expect([...(await client.png({ html: "<p>a</p>", width: 1280 }))]).toEqual([1, 2, 3]);
    expect(seen.path).toBe("/v1/png");
    expect(seen.type).toMatch(/application\/json/);
    expect(JSON.parse(seen.body!)).toEqual({ html: "<p>a</p>", width: 1280 });
    await client.pdf({ boards: [{ html: "b", width: 800 }] });
    expect(seen.path).toBe("/v1/pdf");
    expect(JSON.parse(seen.body!)).toEqual({ boards: [{ html: "b", width: 800 }] });
    await client.pdf({ boards: [{ html: "m", width: 794 }], paginate: true });
    expect(JSON.parse(seen.body!)).toEqual({ boards: [{ html: "m", width: 794 }], paginate: true });
  });

  it("maps 503 and 429 to export_renderer_unavailable", async () => {
    let status = 503;
    const url = await stub((_req, res) => {
      res.writeHead(status).end('{"error":"busy"}');
    });
    const client = createRendererClient(url);
    await expect(client.png({ html: "x", width: 1280 })).rejects.toThrow("export_renderer_unavailable");
    status = 429;
    await expect(client.png({ html: "x", width: 1280 })).rejects.toThrow("export_renderer_unavailable");
  });

  it("maps other non-2xx to export_failed and never carries the response text", async () => {
    const url = await stub((_req, res) => {
      res.writeHead(500).end('{"error":"render_failed FAKE-RESPONSE-TEXT"}');
    });
    const err = await createRendererClient(url)
      .pdf({ boards: [{ html: "x", width: 800 }] })
      .catch((e: Error) => e);
    expect((err as Error).message).toBe("export_failed");
  });

  it("maps a renderer 413 to export_too_large", async () => {
    const url = await stub((_req, res) => {
      res.writeHead(413).end('{"error":"payload_too_large"}');
    });
    await expect(createRendererClient(url).pdf({ boards: [{ html: "x", width: 800 }] })).rejects.toThrow(
      "export_too_large",
    );
  });

  it("maps a closed port to export_renderer_unavailable", async () => {
    const url = await stub((_req, res) => res.end());
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    await expect(createRendererClient(url).png({ html: "x", width: 1280 })).rejects.toThrow(
      "export_renderer_unavailable",
    );
  });

  it("maps a timeout to export_renderer_unavailable", async () => {
    const url = await stub(() => undefined);
    await expect(createRendererClient(url, { timeoutMs: 100 }).png({ html: "x", width: 1280 })).rejects.toThrow(
      "export_renderer_unavailable",
    );
    server?.closeAllConnections();
  });

  it("refuses a body over MAX_EXPORT_BYTES with export_too_large", async () => {
    const big = Buffer.alloc(21 * 1024 * 1024, 1);
    expect(big.length).toBeGreaterThan(MAX_EXPORT_BYTES);
    const url = await stub((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(big);
    });
    await expect(createRendererClient(url).png({ html: "x", width: 1280 })).rejects.toThrow("export_too_large");
  });
});
