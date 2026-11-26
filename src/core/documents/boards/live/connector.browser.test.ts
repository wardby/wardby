/**
 * The connector in a real browser: two pages run the real board editor and the connector, and this test relays their
 * Yjs updates to each other as the live server would. Element-level sync (nothing else re-renders), two people's
 * changes to one element, undo of your own changes only, class changes sent at once, and an element someone else
 * deleted not coming back. Skipped without Playwright's Chromium.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../../../../..");
const fixture = (p: string) => readFileSync(join(repo, "src/core/documents/boards/fixtures/coffee", p), "utf8");
const FILES = {
  "manifest.json": fixture("manifest.json"),
  ...Object.fromEntries(
    ["home", "menu", "about", "visit"].map((id) => [`boards/${id}.html`, fixture(`boards/${id}.html`)]),
  ),
};

const ENTRY = `
import * as Y from "yjs";
import { createBoardsEditor } from "./boards-editor.js";
import { parseBoardFile } from "./board-file.js";
import { bindBoard } from "./live-board/bind.js";
import { boardMaps } from "../../core/documents/boards/live/model.js";
const b64 = (u) => { let s = ""; for (const c of u) s += String.fromCharCode(c); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const doc = new Y.Doc();
let boards, binding;
doc.on("update", (u, origin) => { if (origin !== "relay") window.__relay(b64(u)); });
window.live = {
  async open(files, build, state) {
    if (state) Y.applyUpdate(doc, unb64(state), "relay");
    const root = document.getElementById("canvas");
    const panel = () => document.createElement("div");
    boards = createBoardsEditor({ container: root, panels: { layers: panel(), styles: panel(), selectors: panel(), traits: panel() }, files, editable: true });
    await boards.ready;
    const parts = parseBoardFile(files["boards/home.html"]);
    binding = bindBoard(boards.editor, boardMaps(doc, "home"), { build, baseCss: boards.baseStyle()?.textContent ?? "", parts: { lang: parts.lang, title: parts.title, bodyAttrs: parts.bodyAttrs } });
    return true;
  },
  receive(u) { Y.applyUpdate(doc, unb64(u), "relay"); },
  state() { return b64(Y.encodeStateAsUpdate(doc)); },
  get editor() { return boards.editor; },
  get binding() { return binding; },
};
`;

let js = "";
let browser: Browser;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What the test reaches in a page (typed here: the page's own modules need the DOM, the test runs in Node). */
type W = {
  live: { editor: import("grapesjs").Editor; binding: { stats: { fullBuilds: number }; undo(): void; redo(): void } };
  getComputedStyle(el: unknown): { getPropertyValue(p: string): string };
};

async function page(): Promise<Page> {
  const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.setContent(
    '<!doctype html><html><body><div id="canvas" style="width:1200px;height:800px"></div></body></html>',
  );
  (p as unknown as { errors: string[] }).errors = errors;
  return p;
}

/** Two pages relayed to each other: A builds the board from the file, B joins from A's live copy. */
async function pair(): Promise<[Page, Page]> {
  const a = await page();
  const b = await page();
  // Each page's own updates go to the other, as the live server relays them.
  await a.exposeFunction("__relay", (u: string) =>
    b
      .evaluate((x) => (globalThis as unknown as { live: { receive(u: string): void } }).live.receive(x), u)
      .catch(() => undefined),
  );
  await b.exposeFunction("__relay", (u: string) =>
    a
      .evaluate((x) => (globalThis as unknown as { live: { receive(u: string): void } }).live.receive(x), u)
      .catch(() => undefined),
  );
  await a.addScriptTag({ content: js });
  await b.addScriptTag({ content: js });
  await a.evaluate(
    (f) => (globalThis as unknown as { live: { open(f: unknown, b: boolean): Promise<boolean> } }).live.open(f, true),
    FILES,
  );
  const state = await a.evaluate(() => (globalThis as unknown as { live: { state(): string } }).live.state());
  await b.evaluate(
    ([f, st]) =>
      (globalThis as unknown as { live: { open(f: unknown, b: boolean, s: string): Promise<boolean> } }).live.open(
        f,
        false,
        st,
      ),
    [FILES, state] as const,
  );
  return [a, b];
}
const style = (p: Page, sel: string, prop: string) =>
  p.evaluate(
    ([s, pr]) =>
      (globalThis as unknown as W)
        .getComputedStyle((globalThis as unknown as W).live.editor.getWrapper()!.find(s)[0].getEl())
        .getPropertyValue(pr),
    [sel, prop] as const,
  );

describe.skipIf(!existsSync(chromium.executablePath()))("the connector (browser)", () => {
  beforeAll(async () => {
    const out = await build({
      stdin: { contents: ENTRY, resolveDir: join(repo, "src/web/app"), loader: "ts", sourcefile: "bind-entry.ts" },
      bundle: true,
      format: "iife",
      platform: "browser",
      target: ["es2022"],
      write: false,
      tsconfig: join(repo, "src/web/app/tsconfig.json"),
      loader: { ".css": "empty" },
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    });
    js = out.outputFiles[0].text;
    browser = await chromium.launch();
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  });

  it("a change reaches the other page element by element; nothing else on its board re-renders", async () => {
    const [a, b] = await pair();
    expect(await b.evaluate(() => (globalThis as unknown as W).live.binding.stats.fullBuilds)).toBe(1);
    await b.evaluate(() => {
      for (const el of Array.from(
        (globalThis as unknown as W).live.editor.Canvas.getDocument()!.querySelectorAll("body *"),
      ))
        (el as { __mark: number }).__mark = 1;
    });
    await a.evaluate(
      () =>
        void (globalThis as unknown as W).live.editor
          .getWrapper()!
          .find("h1")[0]
          .addStyle({ color: "rgb(150, 20, 20)" }),
    );
    await wait(300);
    expect(await style(b, "h1", "color")).toBe("rgb(150, 20, 20)");
    // Every element but the one that changed keeps its DOM node.
    const redrawn = await b.evaluate(() => {
      const all = Array.from((globalThis as unknown as W).live.editor.Canvas.getDocument()!.querySelectorAll("body *"));
      const els = all as unknown as { tagName: string; __mark?: number }[];
      return els.filter((el) => !el.__mark).map((el) => el.tagName.toLowerCase());
    });
    // (GrapesJS rewrites its own <style> block in the canvas whenever CSS changes.)
    expect(redrawn.filter((t) => t !== "h1" && t !== "style")).toEqual([]);
    for (const p of [a, b]) expect((p as unknown as { errors: string[] }).errors).toEqual([]);
    await a.close();
    await b.close();
  }, 60_000);

  it("two people's changes to different properties of one element both stay; a class change goes out at once", async () => {
    const [a, b] = await pair();
    await Promise.all([
      a.evaluate(
        () =>
          void (globalThis as unknown as W).live.editor.getWrapper()!.find("h1")[0].addStyle({ "padding-top": "24px" }),
      ),
      b.evaluate(
        () =>
          void (globalThis as unknown as W).live.editor
            .getWrapper()!
            .find("h1")[0]
            .addStyle({ "letter-spacing": "2px" }),
      ),
    ]);
    await b.evaluate(
      () => void (globalThis as unknown as W).live.editor.getWrapper()!.find("footer")[0].addClass("dark"),
    );
    await wait(400);
    for (const p of [a, b]) {
      expect(await style(p, "h1", "padding-top")).toBe("24px");
      expect(await style(p, "h1", "letter-spacing")).toBe("2px");
      expect(
        await p.evaluate(() => (globalThis as unknown as W).live.editor.getWrapper()!.find("footer")[0].getClasses()),
      ).toContain("dark");
    }
    await a.close();
    await b.close();
  }, 60_000);

  it("undo removes your own change only, redo brings it back, across someone else's change", async () => {
    const [a, b] = await pair();
    await a.evaluate(
      () =>
        void (globalThis as unknown as W).live.editor.getWrapper()!.find("h1")[0].addStyle({ color: "rgb(1, 2, 3)" }),
    );
    await wait(200);
    await b.evaluate(
      () =>
        void (globalThis as unknown as W).live.editor.getWrapper()!.find("h1")[0].addStyle({ "padding-top": "30px" }),
    );
    await wait(300);
    expect(await style(a, "h1", "padding-top")).toBe("30px");
    await a.evaluate(() => (globalThis as unknown as W).live.binding.undo());
    await wait(300);
    for (const p of [a, b]) {
      expect(await style(p, "h1", "color")).not.toBe("rgb(1, 2, 3)");
      expect(await style(p, "h1", "padding-top")).toBe("30px");
    }
    await a.evaluate(() => (globalThis as unknown as W).live.binding.redo());
    await wait(300);
    for (const p of [a, b]) expect(await style(p, "h1", "color")).toBe("rgb(1, 2, 3)");
    await a.close();
    await b.close();
  }, 60_000);

  it("an element someone else deleted does not come back when you edit something else", async () => {
    const [a, b] = await pair();
    const count = (p: Page) =>
      p.evaluate(() => (globalThis as unknown as W).live.editor.getWrapper()!.find("section").length);
    const before = await count(a);
    await b.evaluate(() => void (globalThis as unknown as W).live.editor.getWrapper()!.find("section")[1].remove());
    await a.evaluate(
      () =>
        void (globalThis as unknown as W).live.editor.getWrapper()!.find("h1")[0].addStyle({ color: "rgb(9, 9, 9)" }),
    );
    await wait(500);
    for (const p of [a, b]) expect(await count(p)).toBe(before - 1);
    expect(await style(b, "h1", "color")).toBe("rgb(9, 9, 9)");
    await a.close();
    await b.close();
  }, 60_000);
});
