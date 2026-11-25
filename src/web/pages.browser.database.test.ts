/**
 * The design page in headless Chromium against the real server and the real bundle (run
 * `npm run build:web` first): the page CSP, boards rendered as written, saves, live updates and
 * read-only access. Skipped without DATABASE_URL or a Playwright Chromium.
 */
import { existsSync, readFileSync } from "node:fs";
import { chromium, type Browser, type ConsoleMessage, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forceApprove, submitForReview } from "../core/documents/review.js";
import { createDocument, publishVersion } from "../core/documents/service.js";
import { startTestWebServer, TEST_CIPHER, type TestWebServer } from "./test-server.test-support.js";

/** GrapesJS 0.23.9's canvas iframe. */
const CANVAS = "iframe.gjs-frame";
/** The composer's send key (⌘↵; Ctrl+Enter elsewhere). */
const SUBMIT = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
const PIN_HINT = "Click anything on the board to comment · Esc to cancel";

/** The point a pin marks: the bottom centre of its box (the pin's tip). */
async function tipOf(pin: Locator): Promise<{ x: number; y: number }> {
  const b = (await pin.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height };
}
/** Whether a pin's tip is inside an element's box (1 px of rounding). */
async function tipInside(pin: Locator, el: Locator): Promise<boolean> {
  const b = await el.boundingBox();
  if (!b || (await pin.count()) !== 1) return false;
  const t = await tipOf(pin);
  return t.x >= b.x - 1 && t.x <= b.x + b.width + 1 && t.y >= b.y - 1 && t.y <= b.y + b.height + 1;
}
const pinNumbered = (page: Page, n: number) => page.locator(".pin").filter({ hasText: new RegExp(`^${n}$`) });
async function pickBoard(page: Page, name: string): Promise<void> {
  await page.locator(".boards li", { hasText: name }).locator(".pick").click();
  await expect.poll(() => page.locator(".boards li.on .name").textContent()).toBe(name);
}

const coffee = (p: string) =>
  readFileSync(new URL(`../core/documents/boards/fixtures/coffee/${p}`, import.meta.url), "utf8");
const files = (): Record<string, string> => ({
  "manifest.json": coffee("manifest.json"),
  ...Object.fromEntries(
    ["home", "menu", "about", "visit"].map((id) => [`boards/${id}.html`, coffee(`boards/${id}.html`)]),
  ),
});

/** Collects CSP violations, page errors and requests that leave the server's origin. */
function watch(page: Page, origin: string) {
  const out = { violations: [] as string[], errors: [] as string[], external: [] as string[], puts: [] as string[] };
  page.on("request", (r) => {
    const url = r.url();
    if (r.method() === "PUT") out.puts.push(url);
    if (!url.startsWith(`${origin}/`) && !/^(?:about|data|blob):/.test(url)) out.external.push(url);
  });
  page.on("console", (m: ConsoleMessage) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) out.violations.push(m.text());
  });
  page.on("pageerror", (e) => out.errors.push(e.message));
  return out;
}

describe.skipIf(!process.env.DATABASE_URL || !existsSync(chromium.executablePath()))("design page (browser)", () => {
  let server: TestWebServer;
  let browser: Browser;
  beforeAll(async () => {
    server = await startTestWebServer({ assetsRoot: "dist/web-assets" });
    browser = await chromium.launch();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("loads the design under the page CSP with no violations and renders boards as written", async () => {
    const { documentId, cookie } = await server.design({ title: "Coffee", files: files(), access: "write" });
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const seen = watch(page, server.origin);
    await page.goto(`${server.origin}/d/${documentId}`);
    const canvas = page.frameLocator(CANVAS);
    await expect.poll(() => canvas.locator("h1").first().textContent(), { timeout: 20_000 }).toMatch(/\S/);
    const frame = await (await page.$(CANVAS))?.contentFrame();
    const bg = await frame?.evaluate("getComputedStyle(document.body).backgroundColor");
    expect(bg).toBe("rgb(251, 243, 231)"); // --cream from :root reaches the canvas (base layer + parser)
    // The fidelity check runs once for the version and stores its result.
    await expect
      .poll(
        async () => {
          const v = await server.db.documentVersion.findFirst({ where: { documentId }, select: { warnings: true } });
          return (v?.warnings as Array<{ kind: string }> | null)?.filter((w) => w.kind === "fidelity").length ?? 0;
        },
        { timeout: 20_000 },
      )
      .toBe(4);
    // Measuring switched boards and back: Home is shown again.
    await expect.poll(() => page.locator(".boards li.on .name").textContent()).toBe("Home");
    // Selecting an element renders GrapesJS's Style, Settings and Layers views (still no eval, no violation).
    await canvas.locator("h1").first().click();
    await expect.poll(() => page.locator(".gjs-sm-sector").count()).toBeGreaterThan(0);
    await page.locator("[data-tab=settings]").click();
    await page.getByRole("button", { name: "Phone" }).click();
    await page.locator(".boards li", { hasText: "Menu" }).locator(".pick").click();
    await expect.poll(() => page.locator(".boards li.on .name").textContent()).toBe("Menu");
    // Loading and measuring saved nothing: an unchanged board serialises to its baseline.
    await page.waitForTimeout(2000);
    expect(seen.puts).toEqual([]);
    expect(seen.violations).toEqual([]);
    expect(seen.errors).toEqual([]);
    expect(seen.external).toEqual([]);
    await context.close();
  }, 60_000);

  it("saves an edit as a new version that a second viewer sees live", async () => {
    const { documentId, cookie, secondCookie } = await server.design({
      title: "Coffee",
      files: files(),
      access: "write",
    });
    const ca = await browser.newContext();
    await ca.addCookies([cookie]);
    const cb = await browser.newContext();
    await cb.addCookies([secondCookie]);
    const a = await ca.newPage();
    const b = await cb.newPage();
    const seen = watch(a, server.origin);
    await Promise.all([a.goto(`${server.origin}/d/${documentId}`), b.goto(`${server.origin}/d/${documentId}`)]);
    for (const p of [a, b]) {
      await expect
        .poll(() => p.frameLocator(CANVAS).locator("h1").first().textContent(), { timeout: 20_000 })
        .toMatch(/\S/);
    }
    // Let the fidelity pass finish (it switches boards) before editing.
    await expect.poll(() => a.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    const sent: Record<string, string | null>[] = [];
    a.on("request", (r) => {
      if (r.method() === "PUT")
        sent.push((JSON.parse(r.postData() ?? "{}") as { files: Record<string, string | null> }).files);
    });
    const h1 = a.frameLocator(CANVAS).locator("h1").first();
    await h1.dblclick();
    await a.keyboard.press("End");
    await a.keyboard.type(" (edited)");
    await a.locator(".topbar .crumbs").click();
    await expect.poll(() => a.locator(".badge.version").textContent(), { timeout: 20_000 }).toContain("v2");
    await expect.poll(() => b.locator(".badge.version").textContent(), { timeout: 20_000 }).toContain("v2");
    await expect
      .poll(() => b.frameLocator(CANVAS).locator("h1").first().textContent(), { timeout: 10_000 })
      .toContain("(edited)");
    // Only the changed board was sent, with its base layer as written and the edit in the body.
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0])).toEqual(["boards/home.html"]);
    const home = sent[0]["boards/home.html"]!;
    expect(home).toContain("<style data-wardby-base>\n  :root{\n    --cream:#FBF3E7;");
    expect(home).toContain("<style data-wardby-edits>");
    expect(home).toMatch(/<h1[^>]*>[^<]*\(edited\)[^<]*<\/h1>/);
    expect(seen.violations).toEqual([]);
    expect(seen.errors).toEqual([]);
    await ca.close();
    await cb.close();
  }, 90_000);

  it("keeps the edits layer one copy of the base rules across save cycles, and checks each saved version", async () => {
    const start = files();
    // An at-rule with no selector (GrapesJS never merges those) next to the coffee base rules.
    start["boards/home.html"] = start["boards/home.html"].replace(
      "<style>",
      '<style>\n  @font-face{font-family:"Local Serif";src:local("Georgia");}',
    );
    const { documentId, cookie } = await server.design({ title: "Coffee", files: start, access: "write" });
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const seen = watch(page, server.origin);
    const sent: Record<string, string | null>[] = [];
    page.on("request", (r) => {
      if (r.method() === "PUT")
        sent.push((JSON.parse(r.postData() ?? "{}") as { files: Record<string, string | null> }).files);
    });
    await page.goto(`${server.origin}/d/${documentId}`);
    // The boards list is disabled while the first fidelity pass switches boards, then enabled again.
    await page.waitForSelector(".boards li .pick:disabled", { timeout: 20_000 });
    await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    expect(await page.locator(".boards li .pick:disabled").count()).toBe(0);
    const fidelity = async (n: number) => {
      const v = await server.db.documentVersion.findFirst({
        where: { documentId, number: n },
        select: { warnings: true },
      });
      return ((v?.warnings as Array<{ kind: string; board: string }> | null) ?? []).filter(
        (w) => w.kind === "fidelity",
      );
    };
    await expect.poll(async () => (await fidelity(1)).length, { timeout: 20_000 }).toBe(4);
    const pick = (name: string) => page.locator(".boards li", { hasText: name }).locator(".pick");
    const edits = (text: string) => /<style data-wardby-edits>([\s\S]*?)<\/style>/.exec(text)?.[1] ?? "";
    const sizes: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const h1 = page.frameLocator(CANVAS).locator("h1").first();
      await h1.dblclick();
      await page.keyboard.press("End");
      await page.keyboard.type(` e${i}`);
      await page.locator(".topbar .crumbs").click();
      await expect.poll(() => page.locator(".badge.version").textContent(), { timeout: 20_000 }).toContain(`v${i + 1}`);
      const home = sent[sent.length - 1]["boards/home.html"]!;
      expect(home.match(/@font-face/g)).toHaveLength(2); // once in the base layer, once in the edits
      expect(edits(home).match(/--cream:/g)).toHaveLength(1);
      sizes.push(edits(home).length);
      // Switch away and back: Home reloads from the version just saved.
      await pick("Menu").click();
      await expect.poll(() => page.locator(".boards li.on .name").textContent()).toBe("Menu");
      await pick("Home").click();
      await expect.poll(() => page.locator(".boards li.on .name").textContent()).toBe("Home");
    }
    expect(sent).toHaveLength(3);
    // The edits layer does not grow by a copy of the base each cycle (the base is several KB).
    expect(Math.abs(sizes[1] - sizes[0])).toBeLessThan(64);
    expect(Math.abs(sizes[2] - sizes[1])).toBeLessThan(64);
    // The writer's own last version gets its fidelity entries once the editor is idle: Home measured
    // again, the boards no save touched carried from v1.
    await expect.poll(async () => (await fidelity(4)).length, { timeout: 20_000 }).toBe(4);
    const v1 = await fidelity(1);
    const v4 = await fidelity(4);
    for (const id of ["menu", "about", "visit"]) {
      expect(v4.find((w) => w.board === id)).toEqual(v1.find((w) => w.board === id));
    }
    expect(await page.locator(".boards li.on .name").textContent()).toBe("Home");
    expect(seen.violations).toEqual([]);
    expect(seen.errors).toEqual([]);
    await context.close();
  }, 120_000);

  it("shows inline style attributes in the editor, and keeps them through a save and a reload", async () => {
    const start = files();
    // Inline styles on an element that gets edited and on one that does not.
    start["boards/home.html"] = start["boards/home.html"]
      .replace("<h1>Good coffee", '<h1 style="color: rgb(1, 2, 3)">Good coffee')
      .replace("<p>Little Fern Coffee", '<p style="letter-spacing: 3px">Little Fern Coffee');
    const { documentId, cookie } = await server.design({ title: "Coffee", files: start, access: "write" });
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const seen = watch(page, server.origin);
    const sent: Record<string, string | null>[] = [];
    page.on("request", (r) => {
      if (r.method() === "PUT")
        sent.push((JSON.parse(r.postData() ?? "{}") as { files: Record<string, string | null> }).files);
    });
    const styled = () =>
      page
        .frameLocator(CANVAS)
        .locator("body")
        .evaluate((body) => {
          const h1 = body.querySelector("h1")!;
          const p = h1.nextElementSibling!;
          const css = body.ownerDocument.defaultView!.getComputedStyle;
          return [css(h1).color, css(p).letterSpacing];
        });
    await page.goto(`${server.origin}/d/${documentId}`);
    await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    // In the editor's canvas, not only in Play: loading the stylesheet used to drop these rules.
    await expect.poll(styled, { timeout: 10_000 }).toEqual(["rgb(1, 2, 3)", "3px"]);
    const h1 = page.frameLocator(CANVAS).locator("h1").first();
    await h1.dblclick();
    await page.keyboard.press("End");
    await page.keyboard.type(" (edited)");
    await page.locator(".topbar .crumbs").click();
    await expect.poll(() => page.locator(".badge.version").textContent(), { timeout: 20_000 }).toContain("v2");
    // The saved board still styles both elements (as an id rule in the edits layer).
    const home = sent[sent.length - 1]["boards/home.html"]!;
    expect(home).toMatch(/color:\s*rgb\(1, ?2, ?3\)/);
    expect(home).toMatch(/letter-spacing:\s*3px/);
    await page.reload();
    await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    await expect.poll(styled, { timeout: 10_000 }).toEqual(["rgb(1, 2, 3)", "3px"]);
    expect(await h1.textContent()).toContain("(edited)");
    expect(seen.violations).toEqual([]);
    expect(seen.errors).toEqual([]);
    await context.close();
  }, 90_000);

  it("keeps the edits to each rule of a selector the base styles twice, and Style Manager edits, across reloads", async () => {
    const start = files();
    // A second `.btn` rule, with the same selectors, state and media as the fixture's first one, and
    // an edits layer (as another writer saved it) that changes the first `.btn` rule only.
    const btn = (bg: string) =>
      `.btn{display:inline-block;padding:12px 26px;border-radius:999px;background:${bg};color:var(--paper);text-decoration:none;font-weight:700;}`;
    const second = ".btn{outline:3px dotted rgb(1, 2, 3);}";
    start["boards/home.html"] = start["boards/home.html"].replace(
      "</style>",
      `  ${second}\n</style>\n<style data-wardby-edits>${btn("rgb(4, 5, 6)")}${second}</style>`,
    );
    const { documentId, cookie } = await server.design({ title: "Coffee", files: start, access: "write" });
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const seen = watch(page, server.origin);
    const sent: Record<string, string | null>[] = [];
    page.on("request", (r) => {
      if (r.method() === "PUT")
        sent.push((JSON.parse(r.postData() ?? "{}") as { files: Record<string, string | null> }).files);
    });
    await page.goto(`${server.origin}/d/${documentId}`);
    await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    const canvas = page.frameLocator(CANVAS);
    // Styles the element through the Style Manager (component first, so onto its id rule), then
    // moves that style onto its class rule with the selector manager's sync button.
    const styleClass = async (selector: string, name: string, value: string) => {
      await canvas.locator(selector).first().click();
      await expect.poll(() => page.locator("[data-selected]").first().textContent()).toContain(name);
      const sector = page.locator(".gjs-sm-sector__dimension");
      if (!(await sector.locator(".gjs-sm-property__width").isVisible()))
        await sector.locator(".gjs-sm-sector-title").click();
      const input = sector.locator(".gjs-sm-property__width input").first();
      await input.fill(value);
      await input.press("Enter");
      // One class picker (GrapesJS 0.23.9 loads its selector manager twice; the stale one is removed).
      expect(await page.locator("[data-sync-style]").count()).toBe(1);
      await page.locator("[data-sync-style]").click();
    };
    // Each `.btn` rule keeps its own edits, and the Style Manager edits are on the right elements.
    const check = async (edited = true) => {
      const frame = await (await page.$(CANVAS))?.contentFrame();
      const read = (sel: string, prop: string) =>
        frame?.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).getPropertyValue("${prop}")`);
      expect(await read("a.btn:not(.secondary)", "background-color")).toBe("rgb(4, 5, 6)"); // first `.btn`
      expect(await read("a.btn:not(.secondary)", "outline-style")).toBe("dotted"); // second `.btn`
      if (!edited) return;
      // GrapesJS's Style Manager styles the last `.btn` rule.
      expect(await read("a.btn:not(.secondary)", "width")).toBe("123px");
      expect(await read("span.eyebrow", "width")).toBe("222px"); // a selector the base styles once
    };
    await check(false);
    await styleClass("a.btn:not(.secondary)", "Link", "123px");
    await styleClass("span.eyebrow", "Text", "222px");
    await page.locator(".topbar .crumbs").click();
    await expect.poll(() => page.locator(".badge.version").textContent(), { timeout: 20_000 }).toContain("v2");
    const edits = (text: string) => /<style data-wardby-edits>([\s\S]*?)<\/style>/.exec(text)?.[1] ?? "";
    const saved = edits(sent[0]["boards/home.html"]!);
    expect(saved).toMatch(/\.btn\{[^}]*width:123px/);
    expect(saved).toMatch(/\.eyebrow\{[^}]*width:222px/);
    const pick = (name: string) => page.locator(".boards li", { hasText: name }).locator(".pick");
    const sizes: number[] = [];
    for (let i = 1; i <= 2; i++) {
      // Switch away and back: Home reloads from the version just saved.
      await pick("Menu").click();
      await expect.poll(() => page.locator(".boards li.on .name").textContent()).toBe("Menu");
      await pick("Home").click();
      await expect.poll(() => page.locator(".boards li.on .name").textContent()).toBe("Home");
      await check();
      const h1 = canvas.locator("h1").first();
      await h1.dblclick();
      await page.keyboard.press("End");
      await page.keyboard.type(` e${i}`);
      await page.locator(".topbar .crumbs").click();
      await expect.poll(() => page.locator(".badge.version").textContent(), { timeout: 20_000 }).toContain(`v${i + 2}`);
      const home = edits(sent[sent.length - 1]["boards/home.html"]!);
      expect(home.match(/outline:3px dotted/g)).toHaveLength(1);
      expect(home.match(/width:123px/g)).toHaveLength(1);
      expect(home.match(/background:rgb\(4, 5, 6\)/g)).toHaveLength(1);
      sizes.push(home.length);
    }
    expect(sent).toHaveLength(3);
    expect(Math.abs(sizes[1] - sizes[0])).toBeLessThan(64);
    // A fresh page load reads the last version from the server.
    await page.reload();
    await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    await expect.poll(() => page.locator(".boards li.on .name").textContent()).toBe("Home");
    await check();
    expect(seen.violations).toEqual([]);
    expect(seen.errors).toEqual([]);
    await context.close();
  }, 120_000);

  it("adds, renames, moves and deletes boards, saving the manifest", async () => {
    const { documentId, cookie } = await server.design({ title: "Coffee", files: files(), access: "write" });
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const sent: Record<string, string | null>[] = [];
    page.on("request", (r) => {
      if (r.method() === "PUT")
        sent.push((JSON.parse(r.postData() ?? "{}") as { files: Record<string, string | null> }).files);
    });
    const seen = watch(page, server.origin);
    await page.goto(`${server.origin}/d/${documentId}`);
    await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    await page.getByRole("button", { name: "+ Board" }).click();
    await page.locator("dialog input").fill("Opening Hours");
    await page.locator("dialog").getByRole("button", { name: "Add board" }).click();
    await expect.poll(() => page.locator(".boards li.on .name").textContent()).toBe("Opening Hours");
    // The new board carries the first board's header and starts with its name.
    await expect.poll(() => page.frameLocator(CANVAS).locator("main h1").textContent()).toBe("Opening Hours");
    expect(await page.frameLocator(CANVAS).locator("header.site").count()).toBe(1);
    await expect.poll(() => page.locator(".badge.version").textContent(), { timeout: 20_000 }).toContain("v2");
    expect(Object.keys(sent[0]).sort()).toEqual(["boards/opening-hours.html", "manifest.json"]);
    // Rename and move up, then delete the About board.
    const row = (name: string) => page.locator(".boards li", { hasText: name });
    await row("Opening Hours").locator(".more").click();
    await row("Opening Hours").getByRole("menuitem", { name: "Rename…" }).click();
    await page.locator("dialog input").fill("Hours");
    await page.locator("dialog").getByRole("button", { name: "Rename" }).click();
    await row("Hours").locator(".more").click();
    await row("Hours").getByRole("menuitem", { name: "Move up" }).click();
    await row("About").locator(".more").click();
    await row("About").getByRole("menuitem", { name: "Delete…" }).click();
    await page.locator("dialog").getByRole("button", { name: "Delete" }).click();
    await expect.poll(() => page.locator(".badge.version").textContent(), { timeout: 20_000 }).toContain("v3");
    const last = sent[sent.length - 1];
    expect(last["boards/about.html"]).toBeNull();
    const manifest = JSON.parse(last["manifest.json"]!) as { boards: { id: string; name: string }[] };
    expect(manifest.boards.map((x) => `${x.id}:${x.name}`)).toEqual([
      "home:Home",
      "menu:Menu",
      "opening-hours:Hours",
      "visit:Visit",
    ]);
    expect(await page.locator(".boards li .name").allTextContents()).toEqual(["Home", "Menu", "Hours", "Visit"]);
    // A new board's name is cut to 80 characters, as a rename is (even past the input's maxlength).
    await page.getByRole("button", { name: "+ Board" }).click();
    await page.locator("dialog input").evaluate((el) => el.removeAttribute("maxlength"));
    await page.locator("dialog input").fill("N".repeat(100));
    await page.locator("dialog").getByRole("button", { name: "Add board" }).click();
    await expect.poll(() => page.locator(".badge.version").textContent(), { timeout: 20_000 }).toContain("v4");
    const added = JSON.parse(sent[sent.length - 1]["manifest.json"]!) as { boards: { name: string }[] };
    expect(added.boards[added.boards.length - 1].name).toBe("N".repeat(80));
    expect(seen.violations).toEqual([]);
    expect(seen.errors).toEqual([]);
    await context.close();
  }, 90_000);

  it("keeps an open board menu open when the boards list is rebuilt by a new version", async () => {
    const { documentId, cookie, principalIds } = await server.design({
      title: "Coffee",
      files: files(),
      access: "write",
    });
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const seen = watch(page, server.origin);
    await page.goto(`${server.origin}/d/${documentId}`);
    await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    const about = page.locator(".boards li", { hasText: "About" });
    await about.locator(".more").click();
    await expect.poll(() => about.getByRole("menuitem", { name: "Rename…" }).isVisible()).toBe(true);
    // Another writer publishes v2: the page loads it in place and rebuilds the boards list.
    const next = files();
    next["boards/menu.html"] = next["boards/menu.html"].replace("</main>", "<p>Theirs</p></main>");
    await publishVersion(server.db, TEST_CIPHER, {
      documentId,
      files: next,
      via: "editor",
      createdById: principalIds.second,
      expectedNumber: 1,
    });
    await expect.poll(() => page.locator(".badge.version").textContent(), { timeout: 20_000 }).toContain("v2");
    await expect.poll(() => about.getByRole("menuitem", { name: "Rename…" }).isVisible()).toBe(true);
    expect(await page.locator(".boards .bmenu:not([hidden])").count()).toBe(1);
    // A press outside the list still closes it, and stays closed across the next rebuild.
    await page.locator(".topbar .crumbs").click();
    await expect.poll(() => page.locator(".boards .bmenu:not([hidden])").count()).toBe(0);
    expect(seen.errors).toEqual([]);
    await context.close();
  }, 60_000);

  it("shows the conflict notice when someone else saved first, and keeps the edit", async () => {
    const { documentId, cookie, principalIds } = await server.design({
      title: "Coffee",
      files: files(),
      access: "write",
    });
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    await page.goto(`${server.origin}/d/${documentId}`);
    await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    const h1 = page.frameLocator(CANVAS).locator("h1").first();
    await h1.dblclick();
    await page.keyboard.press("End");
    await page.keyboard.type(" (mine)");
    // Another writer publishes v2 while this edit is still being typed.
    const next = files();
    next["boards/menu.html"] = next["boards/menu.html"].replace("</main>", "<p>Theirs</p></main>");
    await publishVersion(server.db, TEST_CIPHER, {
      documentId,
      files: next,
      via: "editor",
      createdById: principalIds.second,
      expectedNumber: 1,
    });
    await expect.poll(() => page.locator(".banner", { hasText: "This design changed" }).isVisible()).toBe(true);
    await page.locator(".topbar .crumbs").click();
    await expect
      .poll(() => page.locator(".save").textContent(), { timeout: 20_000 })
      .toContain("Someone else saved a newer version — reload");
    expect(await h1.textContent()).toContain("(mine)");
    expect(await page.locator(".badge.version").textContent()).toContain("v1");
    await context.close();
  }, 60_000);

  it("is read-only for a commenter: no edit, no save", async () => {
    const { documentId, cookie } = await server.design({ title: "Coffee", files: files(), access: "comment" });
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const writes: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET") writes.push(`${r.method()} ${r.url()}`);
    });
    await page.goto(`${server.origin}/d/${documentId}`);
    const h1 = page.frameLocator(CANVAS).locator("h1").first();
    await expect.poll(() => h1.textContent(), { timeout: 20_000 }).toMatch(/\S/);
    const before = await h1.textContent();
    await h1.dblclick();
    await page.keyboard.type("x");
    await page.waitForTimeout(2500);
    // No save and no fidelity report (that needs write).
    expect(writes).toEqual([]);
    expect(await h1.textContent()).toBe(before);
    expect(await page.locator("[data-tab=style]").isVisible()).toBe(false);
    expect(await page.locator(".badge.version").textContent()).toContain("v1");
    await context.close();
  }, 60_000);
  it("drops a comment pin on an element; it follows the element, survives a reload, and hides when resolved", async () => {
    const { documentId, cookie } = await server.design({ title: "Coffee", files: files(), access: "comment" });
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const seen = watch(page, server.origin);
    await page.goto(`${server.origin}/d/${documentId}`);
    await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    const canvas = page.frameLocator(CANVAS);
    await pickBoard(page, "Menu");
    const hint = page.getByText(PIN_HINT);
    await page.keyboard.press("c");
    await expect.poll(() => hint.isVisible()).toBe(true);
    const h1 = canvas.locator("h1", { hasText: "A short list" });
    const box = (await h1.boundingBox())!;
    const created = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/threads"));
    await h1.click({ position: { x: 30, y: 10 } });
    await expect.poll(() => hint.isVisible()).toBe(false);
    await expect.poll(() => page.locator(".cpop .quote b").textContent()).toBe("“A short list, made well.” · Menu");
    expect(await page.locator(".pin.draft").count()).toBe(1); // the blue + draft pin
    await page.locator(".cpop textarea").fill("Make the prices bigger");
    await page.locator(".cpop textarea").press(SUBMIT);
    const sent = JSON.parse((await created).postData() ?? "{}") as { anchor: Record<string, unknown> };
    expect(sent.anchor).toMatchObject({ type: "element", board: "menu", tag: "h1", words: "A short list, made well." });
    const pin1 = pinNumbered(page, 1);
    await expect.poll(() => pin1.count(), { timeout: 10_000 }).toBe(1);
    expect(await page.locator(".pin.draft").count()).toBe(0);
    const tip = await tipOf(pin1);
    expect(Math.abs(tip.x - (box.x + 30))).toBeLessThanOrEqual(6);
    expect(Math.abs(tip.y - (box.y + 10))).toBeLessThanOrEqual(6);
    // C does nothing while typing in the composer (the thread's reply box is focused now).
    await page.locator(".cpop textarea").press("c");
    expect(await page.locator(".cpop textarea").inputValue()).toBe("c");
    expect(await hint.isVisible()).toBe(false);
    await page.locator(".cpop textarea").fill("");
    // The pin stays on the h1 on a narrower device.
    await page.getByRole("button", { name: "Phone" }).click();
    await expect.poll(async () => (await h1.boundingBox())!.width, { timeout: 10_000 }).toBeLessThanOrEqual(390);
    await expect.poll(() => tipInside(pin1, h1), { timeout: 10_000 }).toBe(true);
    // Esc closes the popover.
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".cpop").count()).toBe(0);
    await page.getByRole("button", { name: "Desktop" }).click();

    // A second thread, on another board.
    await pickBoard(page, "Home");
    await page.keyboard.press("c");
    await expect.poll(() => hint.isVisible()).toBe(true);
    await canvas.locator("h1").first().click();
    await page.locator(".cpop textarea").fill("Second");
    await page.locator(".cpop textarea").press(SUBMIT);
    await expect.poll(() => pinNumbered(page, 2).count(), { timeout: 10_000 }).toBe(1);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".cpop").count()).toBe(0);
    // J and K move between threads, switching boards. An opened thread focuses its reply box, where
    // J and K are typed: focus moves to the popover's close button (not a text field) before each key.
    const head = page.locator(".cpop .quote");
    const leaveReplyBox = async () => {
      // Wait for the reply box to take focus first: on a slow machine it can do so after the close
      // button is focused, and the next J is then typed into the box.
      await expect
        .poll(() => page.locator(".cpop textarea").evaluate((el) => el.ownerDocument.activeElement === el))
        .toBe(true);
      await page.locator(".cpop [data-act=close]").focus();
    };
    await page.keyboard.press("j");
    await expect.poll(() => head.textContent()).toContain("#1 on");
    await expect.poll(() => page.locator(".boards li.on .name").textContent()).toBe("Menu");
    await expect.poll(() => pin1.count()).toBe(1);
    await leaveReplyBox();
    await page.keyboard.press("j");
    await expect.poll(() => head.textContent()).toContain("#2 on");
    await expect.poll(() => page.locator(".boards li.on .name").textContent()).toBe("Home");
    await expect.poll(() => pinNumbered(page, 2).count()).toBe(1);
    await leaveReplyBox();
    await page.keyboard.press("k");
    await expect.poll(() => head.textContent()).toContain("#1 on");
    await page.keyboard.press("Escape");

    // After a reload the pins are back, and the boards list counts open threads per board.
    await page.reload();
    await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    const count = (name: string) => page.locator(".boards li", { hasText: name }).locator(".bcount");
    await expect.poll(() => count("Menu").textContent()).toBe("💬 1");
    expect(await count("Home").textContent()).toBe("💬 1");
    await expect.poll(() => pinNumbered(page, 2).count(), { timeout: 10_000 }).toBe(1);
    expect(await pin1.count()).toBe(0); // another board's pin is not drawn
    // Both threads are found: neither row says "outdated" (the panel was first listed before the canvas loaded).
    const outdated = (text: string) => page.locator(".tp-row", { hasText: text }).locator(".chip.out");
    await expect.poll(() => page.locator(".tp-row", { hasText: "Second" }).count()).toBe(1);
    expect(await outdated("Second").count()).toBe(0);
    expect(await outdated("Make the prices bigger").count()).toBe(0);
    await pickBoard(page, "Menu");
    await expect.poll(() => tipInside(pin1, h1), { timeout: 10_000 }).toBe(true);
    expect(await outdated("Make the prices bigger").count()).toBe(0);
    // Resolve from the ⋯ menu: the pin hides; selecting the thread in the panel shows it again.
    await pin1.click();
    await expect.poll(() => head.textContent()).toContain("#1 on");
    await page.locator(".cpop [data-act=menu]").click();
    await page.getByRole("menuitem", { name: "✓ Resolve" }).click();
    await expect.poll(() => pin1.count()).toBe(0);
    await expect.poll(() => count("Menu").count()).toBe(0);
    await page.getByRole("tab", { name: /^Resolved/ }).click();
    await page.locator(".tp-row", { hasText: "Make the prices bigger" }).click();
    await expect.poll(() => pin1.count()).toBe(1);
    expect(await pin1.getAttribute("class")).toContain("resolved");
    // All lists open and resolved threads together; Open lists only the open one.
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: /^All/ }).click();
    await expect.poll(() => page.locator(".tp-row").count()).toBe(2);
    await page.getByRole("tab", { name: /^Open/ }).click();
    await expect.poll(() => page.locator(".tp-row").count()).toBe(1);
    expect(seen.violations).toEqual([]);
    expect(seen.errors).toEqual([]);
    expect(seen.external).toEqual([]);
    await context.close();
  }, 120_000);

  it("anchors a writer's toolbar comment to the stored element and keeps it on a republish of the same files", async () => {
    const { documentId, cookie, principalIds } = await server.design({
      title: "Coffee",
      files: files(),
      access: "write",
    });
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const seen = watch(page, server.origin);
    await page.goto(`${server.origin}/d/${documentId}`);
    await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    await pickBoard(page, "Menu");
    const h1 = page.frameLocator(CANVAS).locator("h1", { hasText: "A short list" });
    // Selecting gives the h1 an id GrapesJS made up; it is not in the stored file, so it is not the anchor.
    await h1.click();
    const created = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/threads"));
    await page.locator(".gjs-toolbar [title=Comment]").click();
    await expect.poll(() => page.locator(".cpop .quote b").textContent()).toBe("“A short list, made well.” · Menu");
    await page.locator(".cpop textarea").fill("Bigger please");
    await page.locator(".cpop textarea").press(SUBMIT);
    const anchor = (JSON.parse((await created).postData() ?? "{}") as { anchor: Record<string, unknown> }).anchor;
    expect(anchor).toMatchObject({ type: "element", board: "menu", tag: "h1", dx: 0.5, dy: 0.5 });
    expect(anchor.elementId).toBeUndefined();
    const pin1 = pinNumbered(page, 1);
    await expect.poll(() => tipInside(pin1, h1), { timeout: 10_000 }).toBe(true);
    // The same files published again (as an agent or MCP would): the server finds the thread's element.
    const out = await publishVersion(server.db, TEST_CIPHER, {
      documentId,
      files: files(),
      via: "editor",
      createdById: principalIds.second,
      expectedNumber: 1,
    });
    expect(out.reanchored).toEqual({ kept: 1, outdated: 0 });
    await expect.poll(() => page.locator(".badge.version").textContent(), { timeout: 20_000 }).toContain("v2");
    await expect.poll(() => tipInside(pin1, h1), { timeout: 10_000 }).toBe(true);
    expect(seen.violations).toEqual([]);
    expect(seen.errors).toEqual([]);
    await context.close();
  }, 90_000);

  it("gives a commenter 💬 in the element toolbar, and a reader none", async () => {
    const { documentId, cookie } = await server.design({ title: "Coffee", files: files(), access: "comment" });
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const seen = watch(page, server.origin);
    await page.goto(`${server.origin}/d/${documentId}`);
    await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    await pickBoard(page, "Menu");
    const h1 = page.frameLocator(CANVAS).locator("h1", { hasText: "A short list" });
    await h1.click();
    // Only what works on a locked board: no move, copy or delete.
    await expect.poll(() => page.locator(".gjs-toolbar [title=Comment]").count()).toBe(1);
    expect(await page.locator(".gjs-toolbar .gjs-toolbar-item").count()).toBeLessThanOrEqual(2);
    const created = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/threads"));
    await page.locator(".gjs-toolbar [title=Comment]").click();
    await expect.poll(() => page.locator(".cpop .quote b").textContent()).toBe("“A short list, made well.” · Menu");
    await page.locator(".cpop textarea").fill("Bigger please");
    await page.locator(".cpop textarea").press(SUBMIT);
    const anchor = (JSON.parse((await created).postData() ?? "{}") as { anchor: Record<string, unknown> }).anchor;
    expect(anchor).toMatchObject({ type: "element", board: "menu", tag: "h1", dx: 0.5, dy: 0.5 });
    expect(seen.violations).toEqual([]);
    expect(seen.errors).toEqual([]);
    await context.close();

    // A reader cannot comment: the element toolbar has no 💬.
    const read = await server.design({ title: "Coffee", files: files(), access: "read" });
    const readerContext = await browser.newContext();
    await readerContext.addCookies([read.cookie]);
    const reader = await readerContext.newPage();
    await reader.goto(`${server.origin}/d/${read.documentId}`);
    await expect.poll(() => reader.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    await pickBoard(reader, "Menu");
    await reader.frameLocator(CANVAS).locator("h1", { hasText: "A short list" }).click();
    await reader.waitForTimeout(500);
    expect(await reader.locator(".gjs-toolbar [title=Comment]").count()).toBe(0);
    expect(await reader.locator(".gjs-toolbar .gjs-toolbar-item").count()).toBeLessThanOrEqual(1);
    await readerContext.close();
  }, 90_000);

  it("lets a guest on a comment link pin a comment under their name, with no @-list", async () => {
    const { sharePath } = await server.design({ title: "Coffee", files: files(), access: "read", share: "comment" });
    const context = await browser.newContext();
    const page = await context.newPage();
    const seen = watch(page, server.origin);
    await page.goto(`${server.origin}${sharePath!}`);
    await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    await page.keyboard.press("c");
    await expect.poll(() => page.getByText(PIN_HINT).isVisible()).toBe(true);
    await page.frameLocator(CANVAS).locator("h1").first().click();
    const name = page.locator(".cpop input[data-name]");
    await expect.poll(() => name.isVisible()).toBe(true);
    await name.fill("Gus");
    const ta = page.locator(".cpop textarea");
    expect(await ta.getAttribute("placeholder")).not.toContain("@");
    await ta.fill("@");
    await ta.press("Backspace");
    await ta.pressSequentially("@G");
    expect(await page.locator(".cpop .suggest").count()).toBe(0);
    await ta.fill("Looks good");
    await ta.press(SUBMIT);
    await expect
      .poll(() => page.locator(".cpop .msg .who").first().textContent(), { timeout: 10_000 })
      .toContain("Gus (guest)");
    await expect.poll(() => pinNumbered(page, 1).count()).toBe(1);
    expect(seen.violations).toEqual([]);
    expect(seen.errors).toEqual([]);
    await context.close();
  }, 60_000);

  it("lists the versions, shows an older one read-only, and restores it as a new version", async () => {
    const { documentId, cookie } = await server.design({ title: "Coffee", files: files(), access: "write" });
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const seen = watch(page, server.origin);
    await page.goto(`${server.origin}/d/${documentId}`);
    await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    const h1 = page.frameLocator(CANVAS).locator("h1").first();
    const original = (await h1.textContent())!;
    await h1.dblclick();
    await page.keyboard.press("End");
    await page.keyboard.type(" (edited)");
    await page.locator(".topbar .crumbs").click();
    await expect.poll(() => page.locator(".badge.version").textContent(), { timeout: 20_000 }).toContain("v2");
    // A selected element, so the Style and Settings panes have something to edit.
    await h1.click();
    await expect.poll(() => page.frameLocator(CANVAS).locator(".gjs-selected").count()).toBe(1);
    await page.locator("[data-tab=history]").click();
    await expect.poll(() => page.locator(".tp-row").count()).toBe(2);
    expect(await page.locator(".tp-row").first().textContent()).toContain("latest");
    // Viewing v1: its boards, read-only (an empty sandbox), comments and editing off.
    await page.locator('.tp-row[data-version="1"]').click();
    const view = page.locator(".overlay.version-view");
    await expect.poll(() => view.isVisible()).toBe(true);
    // A layer over the canvas beside a usable sidebar: a labelled region, not a modal dialog.
    expect(await view.getAttribute("role")).toBe("region");
    expect(await view.getAttribute("aria-modal")).toBeNull();
    expect(await view.getAttribute("aria-label")).toBe("Version 1");
    expect(await view.locator("iframe").getAttribute("sandbox")).toBe("");
    expect(await view.locator(".vv-boards button").count()).toBe(4);
    await expect.poll(() => view.frameLocator("iframe").locator("h1").first().textContent()).toBe(original);
    expect(await view.textContent()).toContain("Viewing v1");
    // Nothing is selected, and the Style and Settings panes cannot be used: an attempt saves nothing.
    expect(await page.frameLocator(CANVAS).locator(".gjs-selected").count()).toBe(0);
    // The pane that goes with a tab (same order in the right sidebar).
    const inert = (tab: string) =>
      page.evaluate<boolean>(`(() => {
        const tabs = [...document.querySelectorAll(".dside.right [role=tab]")];
        const i = tabs.indexOf(document.querySelector("[data-tab=${tab}]"));
        return document.querySelectorAll(".dside.right .tabpane")[i].inert;
      })()`);
    expect(await inert("style")).toBe(true);
    expect(await inert("settings")).toBe(true);
    expect(await inert("comments")).toBe(false);
    expect(await inert("history")).toBe(false);
    const putsBefore = seen.puts.length;
    await page.locator("[data-tab=style]").click();
    const stylePane = (await page.locator(".dside.right .gjs-host.styles").boundingBox())!;
    await page.mouse.click(stylePane.x + 20, stylePane.y + 20);
    await page.keyboard.type("40px");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2500); // past the 1.5 s save delay
    expect(seen.puts.length).toBe(putsBefore);
    await page.locator("[data-tab=history]").click();
    await page.keyboard.press("Escape");
    await expect.poll(() => view.count()).toBe(0);
    expect(await inert("style")).toBe(false);
    expect(await inert("settings")).toBe(false);
    // Restore creates v3, "Restored v1", and the editor shows it.
    await page.locator('.tp-row[data-version="1"]').click();
    await page.getByRole("button", { name: "Restore this version" }).click();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect.poll(() => page.locator(".badge.version").textContent(), { timeout: 20_000 }).toContain("v3");
    await expect.poll(() => view.count()).toBe(0);
    await expect.poll(() => h1.textContent(), { timeout: 10_000 }).toBe(original);
    const latest = await server.db.documentVersion.findFirst({
      where: { documentId },
      orderBy: { number: "desc" },
      select: { number: true, summary: true },
    });
    expect(latest).toEqual({ number: 3, summary: "Restored v1" });
    await expect.poll(() => page.locator(".tp-row").first().textContent()).toContain("Restored v1");
    expect(seen.violations).toEqual([]);
    expect(seen.errors).toEqual([]);
    await context.close();
  }, 90_000);

  it("opens History with its versions when the page is reached on ?tab=history (a plan bar link)", async () => {
    const { documentId, cookie } = await server.design({ title: "Coffee", files: files(), access: "write" });
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    await page.goto(`${server.origin}/d/${documentId}?tab=history`);
    // No click on the tab: the versions load because the page arrived on it.
    await expect
      .poll(() => page.locator("[data-tab=history]").getAttribute("aria-selected"), { timeout: 20_000 })
      .toBe("true");
    await expect.poll(() => page.locator(".tp-row").count(), { timeout: 20_000 }).toBe(1);
    expect(new URL(page.url()).search).toBe("");
    await context.close();
  }, 60_000);

  it("lets a reader see the history but not restore", async () => {
    const { documentId, cookie } = await server.design({ title: "Coffee", files: files(), access: "read" });
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    await page.goto(`${server.origin}/d/${documentId}`);
    await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
    await page.locator("[data-tab=history]").click();
    await expect.poll(() => page.locator(".tp-row").count()).toBe(1);
    await page.locator('.tp-row[data-version="1"]').click();
    await expect.poll(() => page.locator(".overlay.version-view").isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Back to latest" }).count()).toBe(1);
    await context.close();
  }, 60_000);
});

const withLink = (): Record<string, string> => {
  const f = files();
  f["boards/home.html"] = f["boards/home.html"].replace(
    "</body>",
    '<a class="outside" href="https://example.com/away">Outside</a></body>',
  );
  return f;
};

describe.skipIf(!process.env.DATABASE_URL || !existsSync(chromium.executablePath()))(
  "Overview, Play and Export (browser)",
  () => {
    let server: TestWebServer;
    let bare: TestWebServer;
    let browser: Browser;
    beforeAll(async () => {
      server = await startTestWebServer({ assetsRoot: "dist/web-assets", exports: "fake" });
      bare = await startTestWebServer({ assetsRoot: "dist/web-assets", exports: null });
      browser = await chromium.launch();
    }, 60_000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
      await bare?.close();
    });

    async function open(srv: TestWebServer, hash = "", access: "write" | "read" = "write") {
      const { documentId, cookie } = await srv.design({ title: "Coffee", files: withLink(), access });
      const context = await browser.newContext({ acceptDownloads: true });
      await context.addCookies([cookie]);
      const page = await context.newPage();
      const seen = watch(page, srv.origin);
      await page.goto(`${srv.origin}/d/${documentId}${hash}`);
      await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
      return { page, context, seen, documentId };
    }

    it("shows every board in Overview as an inert sandboxed tile, and a tile opens that board", async () => {
      const { page, context, seen } = await open(server);
      await page.locator("[data-action=overview]").click();
      const frames = page.locator(".overlay.overview iframe");
      await expect.poll(() => frames.count()).toBe(4);
      for (let i = 0; i < 4; i++) {
        expect(await frames.nth(i).getAttribute("sandbox")).toBe("");
        expect(await frames.nth(i).getAttribute("srcdoc")).toContain("<");
        const inner = await (await frames.nth(i).elementHandle())?.contentFrame();
        expect(await inner!.locator("a[href]").count()).toBe(0);
      }
      await page.locator(".ov-pick[data-board=menu]").click();
      await expect.poll(() => page.locator(".boards li.on .name").textContent()).toBe("Menu");
      expect(await page.locator(".overlay").count()).toBe(0);
      expect(seen.violations).toEqual([]);
      expect(seen.errors).toEqual([]);
      await context.close();
    }, 60_000);

    it("plays the prototype: board links change the fragment, Back returns, devices resize, outside links do nothing, Esc restores the page", async () => {
      const { page, context, seen } = await open(server, "#keep");
      await page.locator("[data-action=play]").click();
      const frameEl = page.locator("iframe.play-frame");
      await expect.poll(() => frameEl.count()).toBe(1);
      expect(await frameEl.getAttribute("sandbox")).toBe("allow-top-navigation-by-user-activation");
      const frame = page.frameLocator("iframe.play-frame");
      await expect.poll(() => frame.locator("h1").first().textContent()).toContain("Good coffee");
      // An outside link has no href, and clicking it changes nothing.
      expect(await frame.locator("a.outside").getAttribute("href")).toBeNull();
      const before = page.url();
      await frame.locator("a.outside").click();
      expect(page.url()).toBe(before);
      expect(await frame.locator("h1").first().textContent()).toContain("Good coffee");
      // A board link sets the fragment and shows that board.
      await frame.locator('a[href="#board-menu"]').first().click();
      await expect.poll(() => page.evaluate<string>("location.hash")).toBe("#board-menu");
      await expect.poll(() => frame.locator("h1").first().textContent()).toContain("A short list");
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect.poll(() => frame.locator("h1").first().textContent()).toContain("Good coffee");
      expect(await page.evaluate<string>("location.hash")).toBe("#board-home");
      // The bar's board buttons replace the fragment: no new history entry.
      const entries = await page.evaluate<number>("history.length");
      await page.locator(".play-bar [data-board=about]").click();
      await expect.poll(() => frame.locator("h1").first().textContent()).toContain("Named after a plant");
      expect(await page.evaluate<string>("location.hash")).toBe("#board-about");
      expect(await page.evaluate<number>("history.length")).toBe(entries);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect.poll(() => frame.locator("h1").first().textContent()).toContain("Good coffee");
      await page.locator("[data-device=Phone]").click();
      await expect.poll(async () => Math.round((await frameEl.boundingBox())!.width)).toBe(390);
      // Esc with focus on the bar closes Play and puts the page's fragment back.
      await page.locator(".play-bar").focus();
      await page.keyboard.press("Escape");
      await expect.poll(() => page.locator(".overlay").count()).toBe(0);
      expect(await page.evaluate<string>("location.hash")).toBe("#keep");
      // Exit does the same.
      await page.locator("[data-action=play]").click();
      await expect.poll(() => frameEl.count()).toBe(1);
      await page.getByRole("button", { name: "Exit", exact: true }).click();
      await expect.poll(() => page.locator(".overlay").count()).toBe(0);
      expect(await page.evaluate<string>("location.hash")).toBe("#keep");
      expect(seen.violations).toEqual([]);
      expect(seen.errors).toEqual([]);
      await context.close();
    }, 60_000);

    it("downloads HTML for a board and the prototype, and PNG and PDF through the renderer", async () => {
      const { page, context, seen } = await open(server);
      const choose = async (name: string) => {
        if (!(await page.getByRole("menuitem", { name }).isVisible()))
          await page.locator("[data-action=export]").click();
        const download = page.waitForEvent("download", { timeout: 20_000 });
        await page.getByRole("menuitem", { name }).click();
        return download;
      };
      expect((await choose("This board (HTML)")).suggestedFilename()).toBe("coffee-home.html");
      expect((await choose("Whole prototype (HTML)")).suggestedFilename()).toBe("coffee-prototype.html");
      expect((await choose("This board (PNG)")).suggestedFilename()).toBe("coffee-home.png");
      expect((await choose("All boards (PDF)")).suggestedFilename()).toBe("coffee-boards.pdf");
      expect(seen.violations).toEqual([]);
      expect(seen.errors).toEqual([]);
      await context.close();
    }, 90_000);

    it("exports the older version on screen, opens no Overview or Play over it, and Esc closes one layer at a time", async () => {
      const { page, context, seen } = await open(server);
      const h1 = page.frameLocator(CANVAS).locator("h1").first();
      const original = (await h1.textContent())!;
      await h1.dblclick();
      await page.keyboard.press("End");
      await page.keyboard.type(" (edited)");
      await page.locator(".topbar .crumbs").click();
      await expect.poll(() => page.locator(".badge.version").textContent(), { timeout: 20_000 }).toContain("v2");
      await page.locator("[data-tab=history]").click();
      await page.locator('.tp-row[data-version="1"]').click();
      const view = page.locator(".overlay.version-view");
      await expect.poll(() => view.isVisible()).toBe(true);
      // Overview and Play do not open over an older version.
      for (const action of ["overview", "play"]) {
        await page.locator(`[data-action=${action}]`).click();
        await page.waitForTimeout(300);
        expect(await page.locator(".overlay.overview, .overlay.play").count()).toBe(0);
      }
      // Export takes the version shown (v1), not the latest (v2).
      await page.locator("[data-action=export]").click();
      const download = page.waitForEvent("download", { timeout: 20_000 });
      await page.getByRole("menuitem", { name: "This board (HTML)" }).click();
      const html = readFileSync(await (await download).path(), "utf8");
      expect(html).toContain(original);
      expect(html).not.toContain("(edited)");
      // Esc closes the open menu only (it stays open after a choice); the next Esc leaves the older version.
      expect(await page.locator(".exp-menu").isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => page.locator(".exp-menu").isVisible()).toBe(false);
      expect(await view.count()).toBe(1);
      await page.keyboard.press("Escape");
      await expect.poll(() => view.count()).toBe(0);
      expect(seen.violations).toEqual([]);
      expect(seen.errors).toEqual([]);
      await context.close();
    }, 90_000);

    it("says PNG and PDF export isn't set up when the server has no renderer, and downloads nothing", async () => {
      const { page, context } = await open(bare);
      let downloads = 0;
      page.on("download", () => downloads++);
      await page.locator("[data-action=export]").click();
      await page.getByRole("menuitem", { name: "This board (PNG)" }).click();
      await expect
        .poll(() => page.locator(".exp-note").textContent())
        .toBe("PNG and PDF export isn't set up on this server.");
      await page.waitForTimeout(500);
      expect(downloads).toBe(0);
      await context.close();
    }, 60_000);

    it("offers Export PDF on a Markdown page only when the server can render, and downloads <slug>.pdf", async () => {
      const make = async (srv: TestWebServer) => {
        const { documentId, cookie } = await srv.design({
          title: "Weekly Notes",
          kind: "document",
          markdown: "# Weekly\n\nHello.\n",
          access: "write",
        });
        const context = await browser.newContext({ acceptDownloads: true });
        await context.addCookies([cookie]);
        const page = await context.newPage();
        await page.goto(`${srv.origin}/d/${documentId}`);
        await expect.poll(() => page.locator(".topbar .title").textContent(), { timeout: 20_000 }).toContain("Weekly");
        return { page, context };
      };
      const withRenderer = await make(server);
      const pdf = withRenderer.page.waitForEvent("download", { timeout: 20_000 });
      await withRenderer.page.getByRole("button", { name: "Export PDF" }).click();
      expect((await pdf).suggestedFilename()).toBe("weekly-notes.pdf");
      await withRenderer.context.close();
      const without = await make(bare);
      expect(await without.page.getByRole("button", { name: "Export PDF" }).count()).toBe(0);
      await without.context.close();
    }, 90_000);
  },
);

describe.skipIf(!process.env.DATABASE_URL || !existsSync(chromium.executablePath()))("plan bar (browser)", () => {
  let server: TestWebServer;
  let browser: Browser;
  beforeAll(async () => {
    server = await startTestWebServer({ assetsRoot: "dist/web-assets" });
    browser = await chromium.launch();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows the set's documents, links between them, and follows the other document's review live", async () => {
    const plan = await server.design({
      title: "Plan title",
      kind: "document",
      markdown: "# Plan\n\nSee [the api](api.md) and [gone](missing.md).\n",
      access: "owner",
      share: "view",
    });
    const owner = plan.principalIds.owner;
    const api = (
      await createDocument(server.db, TEST_CIPHER, { ownerId: owner, title: "Api title", markdown: "# Api\n" })
    ).id;
    const agent = await server.db.agent.create({
      data: { name: `plan-bar-${api}`, systemPrompt: "p", model: "m", budgetUsd: 1, ownerId: owner },
    });
    try {
      const set = await server.db.planSet.create({
        data: { agentId: agent.id, repository: `acme/${api}`, number: 12, store: "wardby", createdByRunId: "run" },
      });
      await server.db.document.update({
        where: { id: plan.documentId },
        data: { planSetId: set.id, planPath: "plan.md" },
      });
      await server.db.document.update({ where: { id: api }, data: { planSetId: set.id, planPath: "api.md" } });

      const context = await browser.newContext();
      await context.addCookies([plan.ownerCookie]);
      const page = await context.newPage();
      const seen = watch(page, server.origin);
      await page.goto(`${server.origin}/d/${plan.documentId}`);
      const bar = page.getByRole("navigation", { name: "Plan" });
      await expect
        .poll(() => bar.locator(".plan-count").textContent(), { timeout: 20_000 })
        .toBe("Plan 12 · 0 of 2 approved");
      expect(await bar.locator("a").count()).toBe(2);
      const current = bar.locator('a[aria-current="page"]');
      expect(await current.count()).toBe(1);
      expect(await current.getAttribute("href")).toBe(`/d/${plan.documentId}`);
      expect(await current.textContent()).toContain("Plan title");
      expect(await bar.locator(`a[href="/d/${api}"]`).textContent()).toContain("Api title");
      // The link to api.md opens its page; the one that matches nothing is plain text with a warning.
      expect(await page.locator(".editor a", { hasText: "the api" }).getAttribute("href")).toBe(`/d/${api}`);
      expect(await page.locator(".editor a", { hasText: "gone" }).count()).toBe(0);
      expect(await page.locator(".editor .plan-link-missing").textContent()).toBe("gone");
      expect(await page.locator(".plan-warnings").textContent()).toContain(
        "Links to files that are not in plan 12: missing.md",
      );

      // The other document is approved: the bar follows without a reload.
      const viewer = { kind: "principal" as const, principalId: owner };
      await submitForReview(server.db, { documentId: api, viewer, reviewers: [plan.principalIds.second] });
      await forceApprove(server.db, TEST_CIPHER, { documentId: api, viewer, note: "ok" });
      await expect
        .poll(() => bar.locator(".plan-count").textContent(), { timeout: 20_000 })
        .toBe("Plan 12 · 1 of 2 approved");
      expect(await bar.locator(`a[href="/d/${api}"] .plan-state`).textContent()).toBe("Approved");
      expect(seen.violations).toEqual([]);
      expect(seen.errors).toEqual([]);
      await context.close();

      // A share-link visitor sees only the document the link opens, and no link into the rest of the set.
      const visitor = await browser.newContext();
      const shared = await visitor.newPage();
      await shared.goto(`${server.origin}${plan.sharePath!}`);
      const sharedBar = shared.getByRole("navigation", { name: "Plan" });
      await expect.poll(() => sharedBar.locator(".plan-count").textContent(), { timeout: 20_000 }).toBe("Plan 12");
      // No count, no link to any member route (not even the current chip), no unresolved-links warning.
      expect(await sharedBar.locator("a").count()).toBe(0);
      expect(await sharedBar.locator('[aria-current="page"]').getAttribute("href")).toBeNull();
      expect(await shared.locator(".plan-warnings:not([hidden])").count()).toBe(0);
      expect(await shared.locator(".editor a", { hasText: "the api" }).count()).toBe(0);
      expect(await shared.locator(`a[href="/d/${api}"]`).count()).toBe(0);
      expect(await shared.content()).not.toContain("Api title");
      await visitor.close();
    } finally {
      await server.db.document.deleteMany({ where: { id: api } });
      await server.db.agent.delete({ where: { id: agent.id } });
    }
  }, 90_000);
});
