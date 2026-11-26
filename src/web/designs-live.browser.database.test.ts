/**
 * Live editing of a design on the real design page (Chromium, real PostgreSQL, the live server): two writers open
 * one design; one builds the board, both say "Live"; typing reaches the other page with no reload and is saved by the
 * server as a version; presence outlines; Undo of your own change; switching boards; renaming a board. The other
 * design browser tests run without the live server, so they keep covering the page's usual saving. Skipped without
 * DATABASE_URL or Playwright's Chromium.
 */
import { existsSync, readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadVersionFiles } from "../core/documents/files.js";
import { startTestWebServer, type BrowserCookie, type TestWebServer } from "./test-server.test-support.js";

/** GrapesJS 0.23.9's canvas iframe. */
const CANVAS = "iframe.gjs-frame";
const coffee = (p: string) =>
  readFileSync(new URL(`../core/documents/boards/fixtures/coffee/${p}`, import.meta.url), "utf8");
const files = (): Record<string, string> => ({
  "manifest.json": coffee("manifest.json"),
  ...Object.fromEntries(
    ["home", "menu", "about", "visit"].map((id) => [`boards/${id}.html`, coffee(`boards/${id}.html`)]),
  ),
});

describe.skipIf(!process.env.DATABASE_URL || !existsSync(chromium.executablePath()))(
  "live design page (browser)",
  () => {
    let server: TestWebServer;
    let browser: Browser;
    const contexts: BrowserContext[] = [];
    beforeAll(async () => {
      server = await startTestWebServer({ assetsRoot: "dist/web-assets", live: true });
      browser = await chromium.launch();
    }, 60_000);
    afterAll(async () => {
      for (const c of contexts) await c.close().catch(() => undefined);
      await browser?.close();
      await server?.close();
    });

    async function open(
      cookie: BrowserCookie,
      documentId: string,
    ): Promise<Page & { errors: string[]; puts: string[] }> {
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      contexts.push(context);
      await context.addCookies([cookie]);
      const page = (await context.newPage()) as Page & { errors: string[]; puts: string[] };
      page.errors = [];
      page.puts = [];
      page.on("pageerror", (e) => page.errors.push(e.message));
      page.on("console", (m) => {
        if (/Content Security Policy|Refused to/i.test(m.text())) page.errors.push(m.text());
      });
      page.on("request", (r) => {
        if (r.method() === "PUT") page.puts.push(r.url());
      });
      await page.goto(`${server.origin}/d/${documentId}`);
      await expect
        .poll(() => page.frameLocator(CANVAS).locator("h1").first().textContent(), { timeout: 20_000 })
        .toMatch(/\S/);
      await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
      return page;
    }
    const h1Text = (p: Page) => p.frameLocator(CANVAS).locator("h1").first().textContent();
    /** Types at the end of the heading, retyping when Playwright's keystrokes miss GrapesJS's text box (a tool quirk). */
    async function typeInHeading(p: Page, text: string): Promise<void> {
      const h1 = p.frameLocator(CANVAS).locator("h1").first();
      for (let tries = 0; tries < 4; tries++) {
        await h1.dblclick();
        await p.waitForTimeout(150);
        await p.keyboard.press("End");
        await p.keyboard.type(text, { delay: 15 });
        if ((await h1.textContent())?.includes(text)) break;
      }
      // Close the box (click outside the text).
      await p
        .frameLocator(CANVAS)
        .locator("body")
        .click({ position: { x: 5, y: 5 } });
    }

    it("two writers edit one board live: one builds, both say Live, typing arrives without a reload and is saved", async () => {
      const { documentId, cookie, secondCookie } = await server.design({
        title: "Coffee",
        files: files(),
        access: "write",
      });
      const a = await open(cookie, documentId);
      const b = await open(secondCookie, documentId);
      for (const p of [a, b])
        await expect.poll(() => p.locator(".save .save-text").textContent(), { timeout: 10_000 }).toBe("Live");
      await typeInHeading(a, " LIVE-A");
      await expect.poll(() => h1Text(b), { timeout: 10_000 }).toContain("LIVE-A");
      // Saved by the server from the live copy, not by the page.
      await expect
        .poll(
          async () => {
            const v = await server.db.documentVersion.findFirst({
              where: { documentId },
              orderBy: { number: "desc" },
              select: { id: true },
            });
            return v ? ((await loadVersionFiles(server.db, v.id))["boards/home.html"] ?? "").includes("LIVE-A") : false;
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      expect([...a.puts, ...b.puts].filter((u) => u.includes("/content"))).toEqual([]);
      expect([...a.errors, ...b.errors]).toEqual([]);
    }, 120_000);

    it("shows who selected what, and Undo removes your own change only", async () => {
      const { documentId, cookie, secondCookie } = await server.design({
        title: "Coffee",
        files: files(),
        access: "write",
      });
      const a = await open(cookie, documentId);
      const b = await open(secondCookie, documentId);
      const aName = ((await a.locator(".who-am-i").textContent()) ?? "").replace(/^Signed in as /, "");
      await a.frameLocator(CANVAS).locator("h1").first().click();
      await expect.poll(() => b.locator(".people .who span").first().textContent(), { timeout: 10_000 }).toBe(aName);
      // Bo edits a paragraph; Ann edits the heading, then undoes: Bo's paragraph stays.
      const para = (p: Page) => p.frameLocator(CANVAS).locator(".hero p").first();
      for (let tries = 0; tries < 4; tries++) {
        await para(b).dblclick();
        await b.waitForTimeout(150);
        await b.keyboard.press("End");
        await b.keyboard.type(" BO-PARA", { delay: 15 });
        if ((await para(b).textContent())?.includes("BO-PARA")) break;
      }
      await b
        .frameLocator(CANVAS)
        .locator("body")
        .click({ position: { x: 5, y: 5 } });
      await expect.poll(() => para(a).textContent(), { timeout: 10_000 }).toContain("BO-PARA");
      await typeInHeading(a, " ANN-UNDO");
      await expect.poll(() => h1Text(b), { timeout: 10_000 }).toContain("ANN-UNDO");
      await a.locator('button[title^="Undo"], button[aria-label^="Undo"]').first().click();
      await expect.poll(() => h1Text(b), { timeout: 10_000 }).not.toContain("ANN-UNDO");
      expect(await para(b).textContent()).toContain("BO-PARA");
      expect([...a.errors, ...b.errors]).toEqual([]);
    }, 120_000);

    it("another board is built by whoever opens it first and read by the others", async () => {
      const { documentId, cookie, secondCookie } = await server.design({
        title: "Coffee",
        files: files(),
        access: "write",
      });
      const a = await open(cookie, documentId);
      const b = await open(secondCookie, documentId);
      const tab = (p: Page, name: string) => p.locator(".boards .pick", { hasText: name }).first();
      await tab(a, "Menu").click();
      await expect
        .poll(() => a.frameLocator(CANVAS).locator("h1, h2").first().textContent(), { timeout: 10_000 })
        .toMatch(/\S/);
      await a.waitForTimeout(500);
      await tab(b, "Menu").click();
      const first = (p: Page) => p.frameLocator(CANVAS).locator("h1, h2").first();
      for (let tries = 0; tries < 4; tries++) {
        await first(a).dblclick();
        await a.waitForTimeout(150);
        await a.keyboard.press("End");
        await a.keyboard.type(" MENU-EDIT", { delay: 15 });
        if ((await first(a).textContent())?.includes("MENU-EDIT")) break;
      }
      await a
        .frameLocator(CANVAS)
        .locator("body")
        .click({ position: { x: 5, y: 5 } });
      await expect.poll(() => first(b).textContent(), { timeout: 10_000 }).toContain("MENU-EDIT");
      expect([...a.errors, ...b.errors]).toEqual([]);
    }, 120_000);

    it("switching boards never writes one board into another: each board keeps its own content and edits", async () => {
      const { documentId, cookie } = await server.design({ title: "Coffee", files: files(), access: "write" });
      const a = await open(cookie, documentId);
      const tab = (name: string) => a.locator(".boards .pick", { hasText: name }).first();
      const heading = () => a.frameLocator(CANVAS).locator("h1, h2").first();
      const typeInFirstHeading = async (text: string) => {
        for (let tries = 0; tries < 4; tries++) {
          await heading().dblclick();
          await a.waitForTimeout(150);
          await a.keyboard.press("Control+End");
          await a.keyboard.type(text, { delay: 15 });
          if ((await heading().textContent())?.includes(text)) break;
        }
      };
      // Types on Home and switches to Menu with the text box still open (the switch closes it), then types on Menu,
      // then switches back and forth again.
      await typeInFirstHeading(" HOME-EDIT");
      await tab("Menu").click();
      await expect.poll(async () => (await heading().textContent()) ?? "", { timeout: 15_000 }).toMatch(/short list/i);
      await a.waitForTimeout(800);
      await typeInFirstHeading(" MENU-EDIT");
      await a
        .frameLocator(CANVAS)
        .locator("body")
        .click({ position: { x: 5, y: 5 } });
      await tab("Home").click();
      await a.waitForTimeout(800);
      await tab("Menu").click();
      await a.waitForTimeout(800);
      await tab("Home").click();
      const latestFiles = async () => {
        const v = await server.db.documentVersion.findFirst({
          where: { documentId },
          orderBy: { number: "desc" },
          select: { id: true },
        });
        return v ? loadVersionFiles(server.db, v.id) : ({} as Record<string, string>);
      };
      await expect
        .poll(
          async () => {
            const f = await latestFiles();
            return (
              (f["boards/home.html"] ?? "").includes("HOME-EDIT") && (f["boards/menu.html"] ?? "").includes("MENU-EDIT")
            );
          },
          { timeout: 20_000 },
        )
        .toBe(true);
      const f = await latestFiles();
      const original = (path: string) => new JSDOM(files()[path]).window.document;
      const saved = (path: string) => new JSDOM(f[path]).window.document;
      // Each board is still itself: its own heading, sections and element count, and only its own edit.
      for (const [path, edit, other] of [
        ["boards/home.html", "HOME-EDIT", "MENU-EDIT"],
        ["boards/menu.html", "MENU-EDIT", "HOME-EDIT"],
      ] as const) {
        const [o, n] = [original(path), saved(path)];
        expect(n.querySelector("h1, h2")?.textContent).toContain(
          (o.querySelector("h1, h2")?.textContent ?? "").trim().slice(0, 12),
        );
        expect(n.body.querySelectorAll("*").length, path).toBe(o.body.querySelectorAll("*").length);
        expect(f[path]).toContain(edit);
        expect(f[path]).not.toContain(other);
      }
      expect(a.errors).toEqual([]);
    }, 120_000);

    it("the keyboard's Undo undoes your own change only, like the button, never someone else's later change", async () => {
      const { documentId, cookie, secondCookie } = await server.design({
        title: "Coffee",
        files: files(),
        access: "write",
      });
      const a = await open(cookie, documentId);
      const b = await open(secondCookie, documentId);
      await typeInHeading(a, " ANN-KEY");
      await expect.poll(() => h1Text(b), { timeout: 10_000 }).toContain("ANN-KEY");
      // Bo then changes the same heading.
      await typeInHeading(b, " BO-AFTER");
      await expect.poll(() => h1Text(a), { timeout: 10_000 }).toContain("BO-AFTER");
      // Ann presses Cmd/Ctrl+Z in the canvas: her change was overwritten by Bo's, so nothing of Bo's goes.
      await a
        .frameLocator(CANVAS)
        .locator("body")
        .click({ position: { x: 5, y: 5 } });
      await a.keyboard.press("ControlOrMeta+z");
      await a.waitForTimeout(1500);
      expect(await h1Text(b)).toContain("BO-AFTER");
      expect(await h1Text(a)).toContain("BO-AFTER");
      expect([...a.errors, ...b.errors]).toEqual([]);
    }, 120_000);

    it("two people typing at once in different text boxes: each keeps their caret and their text, in order", async () => {
      const { documentId, cookie, secondCookie } = await server.design({
        title: "Coffee",
        files: files(),
        access: "write",
      });
      const a = await open(cookie, documentId);
      const b = await open(secondCookie, documentId);
      /** Opens a text box and puts the caret at its very end (not the first line's end). */
      const openAtEnd = async (p: Page, sel: string) => {
        const el = p.frameLocator(CANVAS).locator(sel).first();
        for (let tries = 0; tries < 4; tries++) {
          await el.dblclick();
          await p.waitForTimeout(200);
          if (await el.evaluate((n) => !!n.closest("[contenteditable=true]"))) break;
        }
        await el.evaluate((node) => {
          const r = node.ownerDocument.createRange();
          r.selectNodeContents(node);
          r.collapse(false);
          const s = node.ownerDocument.getSelection()!;
          s.removeAllRanges();
          s.addRange(r);
        });
        return el;
      };
      const [ha, pb] = [await openAtEnd(a, "h1"), await openAtEnd(b, ".hero p")];
      await Promise.all([
        a.keyboard.type(" ANN-TYPES-IN-ORDER", { delay: 70 }),
        b.keyboard.type(" BO-TYPES-IN-ORDER", { delay: 70 }),
      ]);
      // While open, each box holds its own typing in order (at the end, where the caret was).
      expect((await ha.textContent())?.trimEnd()).toMatch(/ ANN-TYPES-IN-ORDER$/);
      expect((await pb.textContent())?.trimEnd()).toMatch(/ BO-TYPES-IN-ORDER$/);
      for (const p of [a, b])
        await p
          .frameLocator(CANVAS)
          .locator("body")
          .click({ position: { x: 5, y: 5 } });
      // Once closed, everyone has both.
      for (const p of [a, b]) {
        await expect
          .poll(() => p.frameLocator(CANVAS).locator("h1").first().textContent(), { timeout: 10_000 })
          .toMatch(/ ANN-TYPES-IN-ORDER\s*$/);
        await expect
          .poll(() => p.frameLocator(CANVAS).locator(".hero p").first().textContent(), { timeout: 10_000 })
          .toMatch(/ BO-TYPES-IN-ORDER\s*$/);
      }
      expect([...a.errors, ...b.errors]).toEqual([]);
    }, 120_000);

    it("two people typing in the same text box at once: both keep their words", async () => {
      const { documentId, cookie, secondCookie } = await server.design({
        title: "Coffee",
        files: files(),
        access: "write",
      });
      const a = await open(cookie, documentId);
      const b = await open(secondCookie, documentId);
      const openAtEnd = async (p: Page) => {
        const el = p.frameLocator(CANVAS).locator(".hero p").first();
        for (let tries = 0; tries < 4; tries++) {
          await el.dblclick();
          await p.waitForTimeout(200);
          if (await el.evaluate((n) => !!n.closest("[contenteditable=true]"))) break;
        }
        await el.evaluate((node) => {
          const r = node.ownerDocument.createRange();
          r.selectNodeContents(node);
          r.collapse(false);
          const s = node.ownerDocument.getSelection()!;
          s.removeAllRanges();
          s.addRange(r);
        });
      };
      await openAtEnd(a);
      await openAtEnd(b);
      await Promise.all([
        a.keyboard.type(" ANN-SAME-BOX", { delay: 70 }),
        b.keyboard.type(" BO-SAME-BOX", { delay: 70 }),
      ]);
      for (const p of [a, b])
        await p
          .frameLocator(CANVAS)
          .locator("body")
          .click({ position: { x: 5, y: 5 } });
      for (const p of [a, b]) {
        const para = () => p.frameLocator(CANVAS).locator(".hero p").first().textContent();
        await expect.poll(async () => (await para()) ?? "", { timeout: 10_000 }).toContain("ANN-SAME-BOX");
        await expect.poll(async () => (await para()) ?? "", { timeout: 10_000 }).toContain("BO-SAME-BOX");
      }
      expect([...a.errors, ...b.errors]).toEqual([]);
    }, 120_000);
  },
);
