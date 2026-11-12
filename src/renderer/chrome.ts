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
/** How long a render waits for its context to close before giving up on it (counted as stuck). */
export const CLOSE_WAIT_MS = 5_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * Waits up to `waitMs` for each context close. A close that has not settled by then is counted as
 * stuck (a wedged Chromium can leave it pending for good); the count drops if it settles later.
 */
export function createCloseWaiter(waitMs: number) {
  let stuck = 0;
  return {
    async wait(closing: Promise<unknown>): Promise<void> {
      let closed = false;
      let late = false;
      const settled = closing.then(
        () => undefined,
        () => undefined,
      );
      void settled.then(() => {
        closed = true;
        if (late) stuck -= 1;
      });
      await Promise.race([settled, sleep(waitMs)]);
      if (!closed) {
        late = true;
        stuck += 1;
      }
    },
    stuck: () => stuck,
  };
}

export interface RenderOptions {
  /** Aborting closes the render's browser context, so the pending Chromium call rejects. */
  signal?: AbortSignal;
}

export interface PdfOptions extends RenderOptions {
  /**
   * Paginated mode (ruling T10-1, a Markdown document): one document laid out as print media on
   * A4 pages (or its own CSS @page size), as many pages as it needs. Default: one page per board,
   * each as tall as its board's content (capped at MAX_RENDER_HEIGHT).
   */
  paginate?: boolean;
}

export interface ChromeRenderer {
  png(html: string, width: number, opts?: RenderOptions): Promise<Buffer>;
  pdf(boards: { html: string; width: number }[], opts?: PdfOptions): Promise<Buffer>;
  /** False once Chromium has gone away (crash or close); every later render would fail. */
  isConnected(): boolean;
  /** Called once when Chromium goes away. */
  onDisconnected(cb: () => void): void;
  /** Render contexts whose close did not settle within CLOSE_WAIT_MS (and has not since). */
  stuckContexts(): number;
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
  const closes = createCloseWaiter(CLOSE_WAIT_MS);

  /**
   * One board in a fresh context. `measure` = lay out as screen media and report the content
   * height (capped); otherwise the page is left as print media and the height is 0.
   */
  async function withBoard<T>(
    html: string,
    width: number,
    measure: boolean,
    signal: AbortSignal | undefined,
    fn: (page: Page, height: number) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw new Error("render aborted");
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width, height: 900 },
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    context.setDefaultTimeout(RENDER_TIMEOUT_MS);
    // On abort the render's promise rejects at once and the context is closed. The pending Playwright
    // call is not awaited: closing a context does not always settle it (newPage can hang).
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("render aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => undefined);
    const work = (async () => {
      await context.route("**/*", async (route) => {
        // A late request can arrive while the context closes; its fulfill/abort then rejects, and
        // that must not become an unhandled rejection.
        try {
          const url = route.request().url();
          if (url === BOARD_URL) {
            await route.fulfill({
              status: 200,
              contentType: "text/html; charset=utf-8",
              headers: { "content-security-policy": PAGE_CSP },
              body: html,
            });
          } else if (url.startsWith("data:")) {
            await route.continue();
          } else {
            await route.abort();
          }
        } catch {
          // The context is gone; nothing left to answer.
        }
      });
      const page = await context.newPage();
      await page.goto(BOARD_URL, { waitUntil: "load", timeout: 15_000 });
      let height = 0;
      if (measure) {
        await page.emulateMedia({ media: "screen" });
        const cdp = await context.newCDPSession(page);
        const metrics = (await cdp.send("Page.getLayoutMetrics")) as { cssContentSize: { height: number } };
        height = Math.max(1, Math.min(MAX_RENDER_HEIGHT, Math.ceil(metrics.cssContentSize.height)));
      }
      return await fn(page, height);
    })();
    work.catch(() => undefined);
    try {
      if (signal?.aborted) throw new Error("render aborted");
      return await Promise.race([work, aborted]);
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      await closes.wait(context.close());
    }
  }

  return {
    png: (html, width, o = {}) =>
      withBoard(html, width, true, o.signal, async (page, height) => {
        await page.setViewportSize({ width, height });
        return page.screenshot({ type: "png" });
      }),
    async pdf(boards, o = {}) {
      const out = await PDFDocument.create();
      for (const b of boards) {
        if (o.signal?.aborted) throw new Error("render aborted");
        const one = await withBoard(b.html, b.width, !o.paginate, o.signal, (page, height) =>
          o.paginate
            ? page.pdf({ format: "A4", preferCSSPageSize: true, printBackground: true })
            : page.pdf({ width: `${b.width}px`, height: `${height}px`, printBackground: true, pageRanges: "1" }),
        );
        const src = await PDFDocument.load(one);
        for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
      }
      return Buffer.from(await out.save());
    },
    isConnected: () => browser.isConnected(),
    onDisconnected(cb) {
      if (!browser.isConnected()) cb();
      else browser.once("disconnected", cb);
    },
    stuckContexts: () => closes.stuck(),
    close: () => browser.close(),
  };
}
