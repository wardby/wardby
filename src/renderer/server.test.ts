import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createRendererServer, DEFAULT_MAX_BODY_BYTES, superviseChrome, type RendererChrome } from "./server.js";

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

function fakeChrome(overrides: Partial<RendererChrome> = {}): RendererChrome {
  return { png: async () => PNG, pdf: async () => PDF, ...overrides };
}

async function start(chrome: RendererChrome, opts: Parameters<typeof createRendererServer>[1] = {}) {
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
    const res = await post(`${url}/v1/png`, { html: "a".repeat(DEFAULT_MAX_BODY_BYTES + 1), width: 1280 });
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
  it("holds a whole 2 MiB design whose every character doubles under JSON escaping", async () => {
    let boards = 0;
    const url = await start(
      fakeChrome({
        pdf: async (b) => {
          boards = b.length;
          return PDF;
        },
      }),
    );
    // 50 boards of quote characters: 2 MiB of board text, 4 MiB once escaped, plus a frame each.
    const html = `<!doctype html><html><head></head><body>${'"'.repeat(Math.floor((2 * 1024 * 1024) / 50))}</body></html>`;
    const body = JSON.stringify({ boards: Array.from({ length: 50 }, () => ({ html, width: 1280 })) });
    expect(Buffer.byteLength(body)).toBeGreaterThan(4 * 1024 * 1024);
    const res = await post(`${url}/v1/pdf`, body);
    expect(res.status).toBe(200);
    expect(boards).toBe(50);
  });

  it("takes one paginated document of up to 3 MiB, and only one", async () => {
    let seen: { count: number; paginate?: boolean } | undefined;
    const url = await start(
      fakeChrome({
        pdf: async (boards, o) => {
          seen = { count: boards.length, paginate: o?.paginate };
          return PDF;
        },
      }),
    );
    const big = "a".repeat(2 * 1024 * 1024);
    const ok = await post(`${url}/v1/pdf`, { boards: [{ html: big, width: 794 }], paginate: true });
    expect(ok.status).toBe(200);
    expect(seen).toEqual({ count: 1, paginate: true });
    await post(`${url}/v1/pdf`, { boards: [{ html: "a", width: 794 }] });
    expect(seen).toEqual({ count: 1, paginate: false });
    for (const body of [
      { boards: [{ html: big, width: 794 }] },
      { boards: [{ html: "a".repeat(3 * 1024 * 1024 + 1), width: 794 }], paginate: true },
      {
        boards: [
          { html: "a", width: 794 },
          { html: "b", width: 794 },
        ],
        paginate: true,
      },
      { boards: [{ html: "a", width: 794 }], paginate: "yes" },
    ]) {
      const res = await post(`${url}/v1/pdf`, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
  });

  it("aborts a render that never finishes, answers render_failed and frees the slot", async () => {
    let calls = 0;
    let aborted = false;
    const url = await start(
      fakeChrome({
        png: async (_html, _width, o) => {
          calls += 1;
          if (calls === 1) {
            o?.signal?.addEventListener("abort", () => (aborted = true));
            return new Promise<Buffer>(() => undefined);
          }
          return PNG;
        },
      }),
      { concurrency: 1, queue: 0, renderDeadlineMs: 150 },
    );
    const started = Date.now();
    const hung = await post(`${url}/v1/png`, { html: "x", width: 1280 });
    expect(hung.status).toBe(500);
    expect(await hung.json()).toEqual({ error: "render_failed" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(aborted).toBe(true);
    const next = await post(`${url}/v1/png`, { html: "x", width: 1280 });
    expect(next.status).toBe(200);
  });

  it("answers 503 on /healthz and renders once the browser is gone", async () => {
    let up = true;
    const url = await start(fakeChrome({ isConnected: () => up }));
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    up = false;
    const health = await fetch(`${url}/healthz`);
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ error: "unavailable" });
    const res = await post(`${url}/v1/png`, { html: "x", width: 1280 });
    expect(res.status).toBe(503);
  });

  it("bounds open connections to the render slots plus the queue", () => {
    const s = createRendererServer(fakeChrome(), { concurrency: 2, queue: 3 });
    expect(s.maxConnections).toBe(9);
  });

  it("exits non-zero with a fixed log line when the browser disconnects", () => {
    const lines: string[] = [];
    const log = pino({ level: "trace" }, { write: (line: string) => void lines.push(line) });
    let lost: (() => void) | undefined;
    const codes: number[] = [];
    superviseChrome({ onDisconnected: (cb) => (lost = cb) }, { log, exit: (code) => codes.push(code) });
    expect(codes).toEqual([]);
    lost!();
    expect(codes).toEqual([1]);
    expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual([
      "renderer browser disconnected; exiting",
    ]);
  });
});
