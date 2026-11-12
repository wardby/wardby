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
});
