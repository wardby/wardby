/**
 * Headless Chromium for PNG/PDF exports (ruling D9). Each render gets a fresh, non-persistent
 * context with JavaScript disabled. The board is served to the page through a route on a reserved
 * name; every other request is aborted except data: URLs, and the page's CSP allows nothing but
 * inline styles and data: images and fonts. The pod also has no egress (NetworkPolicy), so there
 * are two locks on the network. Board text is never logged.
 */
import { chromium, type Browser, type Page } from "playwright-core";
import { PDFDocument } from "pdf-lib";

export const MAX_RENDER_HEIGHT = 16_384;
const BOARD_URL = "https://board.render.invalid/";
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; " +
  "frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
const RENDER_TIMEOUT_MS = 30_000;

export interface ChromeRenderer {
  png(html: string, width: number): Promise<Buffer>;
  pdf(boards: { html: string; width: number }[]): Promise<Buffer>;
  close(): Promise<void>;
}

export async function launchChrome(opts: { executablePath?: string } = {}): Promise<ChromeRenderer> {
  const browser: Browser = await chromium.launch({
    headless: true,
    // Chromium's own sandbox is off: it needs unprivileged user namespaces, which the container
    // runtime's default seccomp profile refuses, so the headless shell will not start with it on
    // (tried in the renderer image as the non-root node user). Isolation of the untrusted board
    // HTML therefore rests on the pod: gVisor (runsc), a non-root user, a read-only root
    // filesystem with all capabilities dropped, no egress (NetworkPolicy), and no database or
    // secrets in the pod; inside the page, JavaScript is off and every request but data: is
    // aborted. On local Docker or kind (runc) there is no gVisor, so the container is the only
    // boundary there.
    chromiumSandbox: false,
    ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
    args: [
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--no-first-run",
      "--mute-audio",
    ],
  });

  async function withBoard<T>(html: string, width: number, fn: (page: Page, height: number) => Promise<T>): Promise<T> {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width, height: 900 },
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    context.setDefaultTimeout(RENDER_TIMEOUT_MS);
    try {
      await context.route("**/*", async (route) => {
        const url = route.request().url();
        if (url === BOARD_URL) {
          return route.fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            headers: { "content-security-policy": PAGE_CSP },
            body: html,
          });
        }
        if (url.startsWith("data:")) return route.continue();
        return route.abort();
      });
      const page = await context.newPage();
      await page.goto(BOARD_URL, { waitUntil: "load", timeout: 15_000 });
      await page.emulateMedia({ media: "screen" });
      const cdp = await context.newCDPSession(page);
      const metrics = (await cdp.send("Page.getLayoutMetrics")) as { cssContentSize: { height: number } };
      const height = Math.max(1, Math.min(MAX_RENDER_HEIGHT, Math.ceil(metrics.cssContentSize.height)));
      return await fn(page, height);
    } finally {
      await context.close();
    }
  }

  return {
    png: (html, width) =>
      withBoard(html, width, async (page, height) => {
        await page.setViewportSize({ width, height });
        return page.screenshot({ type: "png" });
      }),
    async pdf(boards) {
      const out = await PDFDocument.create();
      for (const b of boards) {
        const one = await withBoard(b.html, b.width, (page, height) =>
          page.pdf({ width: `${b.width}px`, height: `${height}px`, printBackground: true, pageRanges: "1" }),
        );
        const src = await PDFDocument.load(one);
        for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
      }
      return Buffer.from(await out.save());
    },
    close: () => browser.close(),
  };
}
