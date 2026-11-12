// Renders with the locally installed Playwright Chromium; skipped when none is installed.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright-core";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChrome, MAX_RENDER_HEIGHT, type ChromeRenderer } from "./chrome.js";

const home = readFileSync(
  new URL("../core/documents/boards/fixtures/coffee/boards/home.html", import.meta.url),
  "utf8",
);

describe.skipIf(!existsSync(chromium.executablePath()))("renderer chrome", () => {
  let chrome: ChromeRenderer;
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.end("x");
  });
  let port = 0;
  beforeAll(async () => {
    chrome = await launchChrome();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await chrome.close();
    server.close();
  });

  it("renders a board to a PNG of the board's width", async () => {
    const png = await chrome.png(home, 1280);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(1280);
  }, 60_000);

  it("runs no script and makes no request outside data: URLs", async () => {
    const base = `http://127.0.0.1:${port}`;
    const html =
      `<!doctype html><head><link rel="stylesheet" href="${base}/link"><meta http-equiv="refresh" content="0;url=${base}/refresh">` +
      `<style>@import url(${base}/import); @font-face{font-family:x;src:url(${base}/font)} body{font-family:x}</style></head>` +
      `<body><img src="${base}/img"><script>fetch("${base}/js")</script>` +
      `<iframe src="${base}/frame"></iframe><iframe src="file:///etc/passwd"></iframe><object data="${base}/object"></object>` +
      `<video poster="${base}/poster"></video><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">` +
      `<div style="background-image:url(${base}/css)">x</div></body>`;
    await chrome.png(html, 800);
    await chrome.pdf([{ html, width: 800 }]);
    expect(hits).toBe(0);
  }, 60_000);

  it("caps the page height", async () => {
    const tall = `<!doctype html><body style="margin:0"><div style="height:${MAX_RENDER_HEIGHT * 2}px">x</div></body>`;
    const png = await chrome.png(tall, 320);
    expect(png.readUInt32BE(20)).toBe(MAX_RENDER_HEIGHT);
  }, 60_000);

  it("merges one PDF page per board", async () => {
    const pdf = await chrome.pdf([
      { html: home, width: 1280 },
      { html: "<!doctype html><body><h1>B</h1></body>", width: 800 },
    ]);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(2);
  }, 60_000);
  it("lays a paginated document out on as many A4 pages as it needs, unclipped", async () => {
    // 220 blocks of 100 px: taller than MAX_RENDER_HEIGHT, which would clip a one-page render.
    const blocks = Array.from({ length: 220 }, (_, i) => `<div style="height:100px">Paragraph ${i}</div>`).join("");
    const html =
      `<!doctype html><html><head><style>@page{size:A4;margin:18mm}body{margin:0}</style></head>` +
      `<body>${blocks}</body></html>`;
    expect(220 * 100).toBeGreaterThan(MAX_RENDER_HEIGHT);
    const doc = await PDFDocument.load(await chrome.pdf([{ html, width: 794 }], { paginate: true }));
    // A4 less 2 × 18 mm is about 987 CSS px of content, so 22 000 px needs at least 22 pages.
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(22);
    const { width, height } = doc.getPage(0).getSize();
    expect(Math.round(width)).toBe(595);
    expect(Math.round(height)).toBe(842);
  }, 60_000);

  it("rejects an aborted render and keeps rendering afterwards", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(chrome.png(home, 1280, { signal: ctl.signal })).rejects.toThrow();
    const ctl2 = new AbortController();
    const pending = chrome.pdf([{ html: home, width: 1280 }], { signal: ctl2.signal });
    setTimeout(() => ctl2.abort(), 5);
    await expect(pending).rejects.toThrow();
    const png = await chrome.png(home, 1280);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  }, 60_000);

  it("reports a lost browser", async () => {
    const other = await launchChrome();
    let lost = 0;
    other.onDisconnected(() => (lost += 1));
    expect(other.isConnected()).toBe(true);
    await other.close();
    expect(other.isConnected()).toBe(false);
    expect(lost).toBe(1);
  }, 60_000);
});
