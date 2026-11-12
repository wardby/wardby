/**
 * The design page in headless Chromium against the real server and the real bundle (run
 * `npm run build:web` first): the page CSP, boards rendered as written, saves, live updates and
 * read-only access. Skipped without DATABASE_URL or a Playwright Chromium.
 */
import { existsSync, readFileSync } from "node:fs";
import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishVersion } from "../core/documents/service.js";
import { startTestWebServer, TEST_CIPHER, type TestWebServer } from "./test-server.test-support.js";

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
      await page.locator("[data-sync-style]:visible").first().click();
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
});
