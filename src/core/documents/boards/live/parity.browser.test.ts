/**
 * The server writes boards and creates elements without GrapesJS, by GrapesJS 0.23.9's own rules (spec "Versions
 * are checkpoints", decision 5). This test holds it to that in a real browser, on every fixture board and an extra
 * board of edge cases:
 * 1. the server's writer equals GrapesJS's own save (`getHtml({ cleanId })` + `getCss`), untouched;
 * 2. the same after edits made through GrapesJS;
 * 3. the server-written file, opened again in GrapesJS, saves back the same (attribute order inside a tag aside:
 *    GrapesJS itself moves `id` first when it reopens a file it wrote);
 * 4. the server's elements from HTML equal GrapesJS's parse of the same HTML (types, tags, attributes, classes,
 *    text-box HTML, children; made-up ids aside).
 * A GrapesJS upgrade must pass this. Skipped without Playwright's Chromium.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { putNodes, nodesFromHtml } from "./elements.js";
import { BOARD_ROOT, boardMaps, F, orderedPairs, R, type BoardMaps } from "./model.js";
import { writeBoard } from "./writer.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../../../../..");
const fixtures = join(here, "../fixtures");

/** A design's files from a fixture folder (manifest + boards). */
function fixtureFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = { "manifest.json": readFileSync(join(dir, "manifest.json"), "utf8") };
  for (const f of readdirSync(join(dir, "boards"))) files[`boards/${f}`] = readFileSync(join(dir, "boards", f), "utf8");
  return files;
}
const designs = readdirSync(fixtures, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(fixtures, d.name, "manifest.json")))
  .map((d) => ({ name: d.name, files: fixtureFiles(join(fixtures, d.name)) }));

/** Edge cases the fixtures may not have: tables, labels, svg, line breaks, booleans, inline styles inside text. */
const EDGE_BOARD = `<!doctype html><html lang="en"><head><title>Edge</title><style>.k{color:red}</style></head><body>
<header class="top"><a href="#board:edge" class="brand"><svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"></circle></svg><span>Brand</span></a></header>
<main>
  <p>14 Hazel Lane<br>Elm &amp; Oak, <b>bold</b> and <span style="color: blue">blue</span></p>
  <table><thead><tr><th>Day</th></tr></thead><tbody><tr><td>Mon</td></tr></tbody></table>
  <label>Name</label> <input type="checkbox" checked>
  <div style="padding: 4px; margin: 0"><h2 id="anchor">Anchor</h2> <span class="k">x</span></div>
  <ul><li>One</li><li>Two</li></ul>
</main>
</body></html>`;
designs.push({
  name: "edge",
  files: {
    "manifest.json": JSON.stringify({
      title: "Edge",
      boards: [{ id: "edge", name: "Edge", file: "boards/edge.html", width: 1280 }],
    }),
    "boards/edge.html": EDGE_BOARD,
  },
});

const ENTRY = `
import * as Y from "yjs";
import { createBoardsEditor } from "./boards-editor.js";
import { parseBoardFile, serializeBoardFile } from "./board-file.js";
import { readBoard } from "./live-board/read.js";
import { boardMaps } from "../../core/documents/boards/live/model.js";
let boards = null;
const b64 = (u) => { let s = ""; for (const c of u) s += String.fromCharCode(c); return btoa(s); };
window.parity = {
  async open(files, board) {
    const root = document.getElementById("canvas");
    root.innerHTML = "";
    const panel = () => document.createElement("div");
    boards = createBoardsEditor({ container: root, panels: { layers: panel(), styles: panel(), selectors: panel(), traits: panel() }, files, editable: true });
    await boards.ready;
    boards.selectBoard(board);
    return true;
  },
  save() {
    const e = boards.editor;
    const root = e.getWrapper();
    return {
      body: e.getHtml({ component: root, cleanId: true }).replace(/^<body[^>]*>|<\\/body>$/g, ""),
      css: e.getCss({ component: root }) ?? "",
    };
  },
  read(board) {
    const doc = new Y.Doc();
    readBoard(boards.editor, boardMaps(doc, board), { baseCss: boards.baseStyle()?.textContent ?? "" });
    return b64(Y.encodeStateAsUpdate(doc));
  },
  fileWith(original, css, body) { return serializeBoardFile(parseBoardFile(original), css, body); },
  get editor() { return boards.editor; },
};
`;

let js = "";
let browser: Browser;
const fromB64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

async function openBoard(files: Record<string, string>, board: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(
    '<!doctype html><html><body><div id="canvas" style="width:1200px;height:800px"></div></body></html>',
  );
  await page.addScriptTag({ content: js });
  await page.evaluate(
    ([f, b]) =>
      (globalThis as unknown as { parity: { open(f: unknown, b: string): Promise<boolean> } }).parity.open(f, b),
    [files, board] as const,
  );
  expect(errors).toEqual([]);
  return page;
}
const save = (p: Page) =>
  p.evaluate(() => (globalThis as unknown as { parity: { save(): { body: string; css: string } } }).parity.save());
async function liveCopy(p: Page, board: string): Promise<BoardMaps> {
  const update = await p.evaluate(
    (b) => (globalThis as unknown as { parity: { read(b: string): string } }).parity.read(b),
    board,
  );
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fromB64(update));
  return boardMaps(doc, board);
}
/** Attribute order inside each tag aside. */
const sortAttrs = (html: string) =>
  html.replace(
    /<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g,
    (_m, tag: string, attrs: string, slash: string) => {
      const list = attrs.match(/[^\s=>/]+(?:="[^"]*")?/g) ?? [];
      return `<${tag}${list.length ? ` ${list.sort().join(" ")}` : ""}${slash}>`;
    },
  );

/** The element tree, ids aside (made-up ids inside text boxes become "#"), with each element's inline-style rule. */
function tree(maps: BoardMaps): unknown[] {
  const byId = new Map<string, [string, string][]>();
  for (const k of maps.ruleOrder.toArray()) {
    const y = maps.rules.get(k);
    const id = y?.get(R.singleId);
    if (typeof id === "string" && /^i[a-z0-9]{2,}/.test(id))
      byId.set(id, orderedPairs(y!.get(R.style) as Y.Map<string>, y!.get(R.props) as Y.Array<string>));
  }
  const one = (id: string): unknown => {
    const n = maps.nodes.get(id)!;
    if (n.get(F.type) === "textnode") return { text: n.get(F.content) };
    const html = n.get(F.html);
    return {
      type: n.get(F.type),
      tag: n.get(F.tag),
      void: !!n.get(F.void),
      classes: n.get(F.classes),
      attrs: orderedPairs(n.get(F.attrs) as Y.Map<unknown>, n.get(F.attrKeys) as Y.Array<string>),
      style: n.get(F.ownId) ? undefined : byId.get(id),
      ...(typeof html === "string"
        ? { html: html.replace(/ id="i[a-z0-9]+(-\d+)?"/g, ' id="#"') }
        : { children: ((n.get(F.children) as Y.Array<string>)?.toArray() ?? []).map(one) }),
    };
  };
  return ((maps.nodes.get(BOARD_ROOT)?.get(F.children) as Y.Array<string>)?.toArray() ?? []).map(one);
}

/** A board's body HTML the way parseBoardFile gives it to the editor. */
function bodyOf(file: string): string {
  const doc = new JSDOM(file).window.document;
  for (const s of Array.from(doc.querySelectorAll("style"))) s.remove();
  return doc.body.innerHTML.replace(/\s+$/, "");
}

const chromiumThere = existsSync(chromium.executablePath());

describe.skipIf(!chromiumThere)("server board writer and element rules match GrapesJS", () => {
  beforeAll(async () => {
    const out = await build({
      stdin: { contents: ENTRY, resolveDir: join(repo, "src/web/app"), loader: "ts", sourcefile: "parity-entry.ts" },
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

  for (const design of designs) {
    const manifest = JSON.parse(design.files["manifest.json"]) as { boards: { id: string; file: string }[] };
    for (const board of manifest.boards) {
      it(`${design.name}/${board.id}: writer, edits, round trip and element rules`, async () => {
        const page = await openBoard(design.files, board.id);
        // 1. Untouched.
        expect(writeBoard(await liveCopy(page, board.id))).toMatchObject(await save(page));

        // 4. Elements from the same HTML, on the server.
        let n = 0;
        const parsed = nodesFromHtml(bodyOf(design.files[board.file]), () => `iserver${++n}`);
        const doc = new Y.Doc();
        const serverMaps = boardMaps(doc, board.id);
        doc.transact(() => {
          const root = new Y.Map<unknown>();
          serverMaps.nodes.set(BOARD_ROOT, root);
          const ch = new Y.Array<string>();
          ch.push(parsed.roots);
          root.set(F.children, ch);
          putNodes(serverMaps, parsed);
        });
        const [mine, theirs] = [tree(serverMaps), tree(await liveCopy(page, board.id))];
        if (process.env.PARITY_DUMP) {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(
            `${process.env.PARITY_DUMP}/${design.name}-${board.id}.server.json`,
            JSON.stringify(mine, null, 1),
          );
          writeFileSync(
            `${process.env.PARITY_DUMP}/${design.name}-${board.id}.grapes.json`,
            JSON.stringify(theirs, null, 1),
          );
        }
        expect(mine).toEqual(theirs);

        // 2. After edits made through GrapesJS.
        await page.evaluate(() => {
          const e = (globalThis as unknown as { parity: { editor: import("grapesjs").Editor } }).parity.editor;
          const w = e.getWrapper()!;
          const heading = w.find("h1, h2")[0];
          heading?.addStyle({ color: "rgb(150, 20, 20)", "padding-top": "12px" });
          const p = w.find("p")[0];
          p?.addClass("lead");
          p?.components("Typed <b>bold</b> &lt;live&gt; &amp; kept");
          const a = w.find("a")[0];
          a?.addAttributes({ title: 'Go "now" & fast' });
          (w.find("section")[0] ?? w.components().at(0)).append('<div class="note"><a href="#board:x">More</a></div>');
          const sections = w.find("section");
          if (sections.length > 1) {
            const last = sections[sections.length - 1];
            const parent = last.parent()!;
            const at = parent.components().indexOf(sections[0]);
            last.remove({ temporary: true });
            parent.components().add(last, { at });
          }
          e.setDevice("Phone");
          heading?.addStyle({ "font-size": "1.4rem" });
          e.setDevice("Desktop");
          w.find("img")[0]?.remove();
        });
        const edited = await save(page);
        const written = writeBoard(await liveCopy(page, board.id));
        expect({ body: written.body, css: written.css }).toEqual(edited);

        // 3. Round trip: what the server wrote, opened again and saved by GrapesJS.
        const file = await page.evaluate(
          ([o, c, b]) =>
            (
              globalThis as unknown as { parity: { fileWith(o: string, c: string, b: string): string } }
            ).parity.fileWith(o, c, b),
          [design.files[board.file], written.css, written.body] as const,
        );
        const again = await openBoard({ ...design.files, [board.file]: file }, board.id);
        const reopened = await save(again);
        expect(sortAttrs(reopened.body)).toBe(sortAttrs(written.body));
        expect(reopened.css).toBe(written.css);
        await again.close();
        await page.close();
      }, 90_000);
    }
  }
});
