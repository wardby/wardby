import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { oauthFetch } from "./http.js";

const options = { privateHostAllowlist: ["127.0.0.1"] };

async function withServer<T>(status: number, type: string, body: string, run: (url: string) => Promise<T>): Promise<T> {
  const s = createServer((_req, res) => res.writeHead(status, { "content-type": type }).end(body));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  try {
    return await run(`http://127.0.0.1:${(s.address() as AddressInfo).port}/x`);
  } finally {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
}

describe("oauthFetch body handling", () => {
  const big = "x".repeat(70 * 1024);

  it("fires the size cap on an oversized 2xx body", async () => {
    await withServer(200, "application/json", JSON.stringify({ pad: big }), (url) =>
      expect(oauthFetch(url, { method: "GET" }, options)).rejects.toMatchObject({ code: "bad_response" }),
    );
  });

  it("leaves json undefined for an oversized non-JSON error response", async () => {
    await withServer(404, "text/html", `<html>${big}</html>`, async (url) => {
      const r = await oauthFetch(url, { method: "GET" }, options);
      expect(r.status).toBe(404);
      expect(r.json).toBeUndefined();
    });
  });

  it("discards the body with ignoreBody: not parsed, and no 64 KiB cap", async () => {
    await withServer(200, "text/event-stream", big, async (url) => {
      const r = await oauthFetch(url, { method: "GET", ignoreBody: true }, options);
      expect(r).toMatchObject({ status: 200, json: undefined });
    });
  });
});
