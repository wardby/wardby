import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { ChromeRenderer } from "./chrome.js";
import { createRendererServer } from "./server.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const PDF = Buffer.from("%PDF-1.7");

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
  }
  server = undefined;
});

function fakeChrome(overrides: Partial<Pick<ChromeRenderer, "png" | "pdf">> = {}): Pick<ChromeRenderer, "png" | "pdf"> {
  return { png: async () => PNG, pdf: async () => PDF, ...overrides };
}

async function start(
  chrome: Pick<ChromeRenderer, "png" | "pdf">,
  opts: Parameters<typeof createRendererServer>[1] = {},
) {
  server = createRendererServer(chrome, opts);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("renderer server", () => {
  it("answers /healthz", async () => {
    const url = await start(fakeChrome());
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("renders a PNG", async () => {
    let seen: { html: string; width: number } | undefined;
    const url = await start(
      fakeChrome({
        png: async (html, width) => {
          seen = { html, width };
          return PNG;
        },
      }),
    );
    const res = await post(`${url}/v1/png`, { html: "x", width: 1280 });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    expect(seen).toEqual({ html: "x", width: 1280 });
  });

  it("renders a PDF of 1-50 boards", async () => {
    const url = await start(fakeChrome());
    const ok = await post(`${url}/v1/pdf`, { boards: [{ html: "a", width: 800 }] });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    for (const boards of [[], Array.from({ length: 51 }, () => ({ html: "a", width: 800 }))]) {
      const res = await post(`${url}/v1/pdf`, { boards });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
  });

  it("refuses a bad width, bad JSON and a wrong method", async () => {
    const url = await start(fakeChrome());
    for (const body of [{ html: "x", width: 100 }, { html: "x", width: 1280.5 }, { width: 1280 }, "{not json"]) {
      const res = await post(`${url}/v1/png`, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
    const get = await fetch(`${url}/v1/png`);
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ error: "not_found" });
  });

  it("refuses an html over the per-board cap", async () => {
    const url = await start(fakeChrome());
    const res = await post(`${url}/v1/png`, { html: "a".repeat(600 * 1024 + 1), width: 1280 });
    expect(res.status).toBe(400);
  });

  it("answers 413 for a body over maxBodyBytes", async () => {
    const url = await start(fakeChrome());
    const res = await post(`${url}/v1/png`, { html: "a".repeat(5 * 1024 * 1024), width: 1280 });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
  });

  it("answers 429 busy beyond concurrency + queue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    const url = await start(
      fakeChrome({
        png: async () => {
          started += 1;
          await gate;
          return PNG;
        },
      }),
      { concurrency: 1, queue: 1 },
    );
    const first = post(`${url}/v1/png`, { html: "x", width: 1280 });
    while (started === 0) await new Promise((r) => setTimeout(r, 5));
    const second = post(`${url}/v1/png`, { html: "x", width: 1280 });
    await new Promise((r) => setTimeout(r, 50));
    const third = await post(`${url}/v1/png`, { html: "x", width: 1280 });
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "busy" });
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(started).toBe(2);
  });

  it("answers 500 render_failed when chrome throws", async () => {
    const url = await start(
      fakeChrome({
        png: async () => {
          throw new Error("chrome crashed");
        },
      }),
    );
    const res = await post(`${url}/v1/png`, { html: "x", width: 1280 });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "render_failed" });
  });

  it("never logs request text, not even when a render fails", async () => {
    const lines: string[] = [];
    const log = pino({ level: "trace" }, { write: (line: string) => void lines.push(line) });
    const secret = "FAKE-RENDER-SECRET";
    const url = await start(
      fakeChrome({
        pdf: async (boards) => {
          throw new Error(`failed on ${boards[0].html}`);
        },
      }),
      { log, maxBodyBytes: 64 * 1024 },
    );
    await post(`${url}/v1/png`, { html: `<p>${secret}</p>`, width: 1280 });
    await post(`${url}/v1/pdf`, { boards: [{ html: `<p>${secret}</p>`, width: 800 }] });
    await post(`${url}/v1/png`, { html: secret, width: 1 });
    await post(`${url}/v1/png`, `{"html":"${secret}`);
    await post(`${url}/v1/png`, { html: secret.repeat(10_000), width: 1280 });
    await fetch(`${url}/${secret}`);
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const line of lines) expect(line).not.toContain(secret);
    const statuses = lines.map((l) => (JSON.parse(l) as { status: number }).status);
    expect(statuses).toEqual(expect.arrayContaining([200, 500, 400, 413, 404]));
  });
});
