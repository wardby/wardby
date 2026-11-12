// The exported prototype in a real browser (ruling D5): a board link inside a sandboxed srcdoc frame
// changes the top page's fragment, and the switcher shows that board. Skipped without a local browser.
// The frame sandbox keeps allow-same-origin (ruling T9-1) so the in-board link works from disk too.
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { prototypeFile } from "./export.js";

const file = () =>
  prototypeFile({
    title: "T",
    boards: [
      {
        id: "home",
        name: "Home",
        width: 800,
        html: '<!doctype html><body><a id="go" href="#board-menu" target="_top">Menu</a></body>',
      },
      { id: "menu", name: "Menu", width: 800, html: '<!doctype html><body><h1 id="m">Menu board</h1></body>' },
    ],
  });

describe.skipIf(!existsSync(chromium.executablePath()))("prototype export in a browser", () => {
  it("follows #board links in a board without scripts in the boards", async () => {
    const html = file();
    const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(html));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      await page.frameLocator("iframe").locator("#go").click();
      await expect.poll(() => page.evaluate("location.hash")).toBe("#board-menu");
      await expect.poll(() => page.frameLocator("iframe").locator("#m").textContent()).toBe("Menu board");
    } finally {
      await browser.close();
      server.close();
    }
  }, 60_000);

  it("follows #board links in a board when opened from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "proto-"));
    const path = join(dir, "p.html");
    await writeFile(path, file());
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(path).href);
      await page.frameLocator("iframe").locator("#go").click();
      await expect.poll(() => page.evaluate("location.hash")).toBe("#board-menu");
      await expect.poll(() => page.frameLocator("iframe").locator("#m").textContent()).toBe("Menu board");
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("switches boards from the switcher when opened from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "proto-"));
    const path = join(dir, "p.html");
    await writeFile(path, file());
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(path).href);
      await expect.poll(() => page.frameLocator("iframe").locator("#go").count()).toBe(1);
      await page.locator('nav a[data-id="menu"]').click();
      await expect.poll(() => page.frameLocator("iframe").locator("#m").textContent()).toBe("Menu board");
    } finally {
      await browser.close();
    }
  }, 60_000);
});
