/**
 * Live co-editing in a real browser (Chromium) against real PostgreSQL: two people in one document, comments
 * that follow their words, read-only viewers, and documents the editor cannot keep. Skipped without
 * DATABASE_URL or Playwright's Chromium.
 */
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type ConsoleMessage, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestWebServer, type BrowserCookie, type TestWebServer } from "./test-server.test-support.js";

const SUBMIT = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
const MD = "# Plan\n\nAnn writes here.\n\nBo writes here.\n";

/** Collects CSP violations, page errors and PUT requests (live editing saves none). */
function watch(page: Page) {
  const out = { violations: [] as string[], errors: [] as string[], puts: [] as string[] };
  page.on("request", (r) => {
    if (r.method() === "PUT") out.puts.push(r.url());
  });
  page.on("console", (m: ConsoleMessage) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) out.violations.push(m.text());
  });
  page.on("pageerror", (e) => out.errors.push(e.message));
  return out;
}

/** Puts the caret (or a selection) inside the paragraph containing `needle`, in the page's editor. */
/** In-page: put the caret (or a selection) in the paragraph whose text contains NEEDLE, carets excluded. */
const SELECT_SCRIPT = `(({ needle, from, to }) => {
  const editor = document.querySelector(".ProseMirror");
  const para = [...editor.querySelectorAll("p")].find((p) => {
    const copy = p.cloneNode(true);
    copy.querySelectorAll(".collab-caret").forEach((c) => c.remove());
    return copy.textContent.includes(needle);
  });
  if (!para) throw new Error("no text " + needle);
  const nodes = [];
  const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest(".collab-caret") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  const at = nodes.map((n) => n.data).join("").indexOf(needle);
  const point = (offset) => {
    let left = at + offset;
    for (const n of nodes) {
      if (left <= n.data.length) return [n, left];
      left -= n.data.length;
    }
    const last = nodes[nodes.length - 1];
    return [last, last.data.length];
  };
  editor.focus();
  const range = document.createRange();
  range.setStart(...point(from));
  range.setEnd(...point(to));
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
})`;

async function select(page: Page, needle: string, from: number, to = from): Promise<void> {
  await page.evaluate(`${SELECT_SCRIPT}(${JSON.stringify({ needle, from, to })})`);
}

/** The highlighted words of the page's comment marks (a caret inside them splits one mark in two). */
const markedText = async (page: Page) => (await page.locator(".comment-mark:not(.draft)").allInnerTexts()).join("");

const editorText = (page: Page): Promise<string> =>
  page.evaluate(`(() => {
    const copy = document.querySelector(".ProseMirror").cloneNode(true);
    copy.querySelectorAll(".collab-caret").forEach((c) => c.remove());
    return copy.textContent || "";
  })()`);

describe.skipIf(!process.env.DATABASE_URL || !existsSync(chromium.executablePath()))(
  "live co-editing (browser)",
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

    async function open(cookie: BrowserCookie, documentId: string): Promise<Page> {
      const context = await browser.newContext();
      contexts.push(context);
      await context.addCookies([cookie]);
      const page = await context.newPage();
      await page.goto(`${server.origin}/d/${documentId}`);
      await expect.poll(() => editorText(page), { timeout: 15_000 }).toContain("Ann writes here.");
      return page;
    }

    it("two people type in the same paragraph at once and see each other's text and caret, saving nothing by PUT", async () => {
      const { documentId, cookie, secondCookie } = await server.design({
        kind: "document",
        title: "Plan",
        markdown: MD,
        access: "write",
      });
      const a = await open(cookie, documentId);
      const b = await open(secondCookie, documentId);
      const seenA = watch(a);
      const seenB = watch(b);
      await expect.poll(() => a.locator(".save").innerText()).toContain("Live");
      await select(a, "Ann writes here.", "Ann writes here.".length);
      await select(b, "Ann writes here.", 0);
      await a.keyboard.type(" A-end");
      await b.keyboard.type("B-start ");
      await expect.poll(() => editorText(a), { timeout: 10_000 }).toContain("B-start Ann writes here. A-end");
      await expect.poll(() => editorText(b), { timeout: 10_000 }).toContain("B-start Ann writes here. A-end");
      // Each sees the other's named caret.
      await expect.poll(() => a.locator(".collab-caret-label").count()).toBeGreaterThan(0);
      expect(seenA.puts.concat(seenB.puts)).toEqual([]);
      expect(seenA.violations.concat(seenB.violations)).toEqual([]);
      expect(seenA.errors.concat(seenB.errors)).toEqual([]);
    }, 60_000);

    it("a comment follows its words when someone else types inside them", async () => {
      const { documentId, cookie, secondCookie } = await server.design({
        kind: "document",
        title: "Plan",
        markdown: MD,
        access: "write",
      });
      const a = await open(cookie, documentId);
      const b = await open(secondCookie, documentId);
      await select(a, "Ann writes here.", 0, "Ann writes".length);
      await a.locator(".bubble").click({ timeout: 5000 });
      await a.locator("textarea").first().fill("Who is Ann?", { timeout: 5000 });
      await a.keyboard.press(SUBMIT);
      await expect.poll(() => markedText(a), { timeout: 10_000 }).toBe("Ann writes");
      // Bo types inside the commented words; Ann's highlight grows to cover them.
      await select(b, "Ann writes here.", "Ann ".length);
      await b.keyboard.type("really ");
      await expect.poll(() => markedText(a), { timeout: 10_000 }).toBe("Ann really writes");
      // And after a reload, from the saved positions.
      await a.reload();
      await expect.poll(() => markedText(a), { timeout: 10_000 }).toBe("Ann really writes");
    }, 60_000);

    it("a comment whose words were deleted comes back when the deletion is undone", async () => {
      const { documentId, cookie, secondCookie } = await server.design({
        kind: "document",
        title: "Plan",
        markdown: MD,
        access: "write",
      });
      const a = await open(cookie, documentId);
      const b = await open(secondCookie, documentId);
      await select(a, "Ann writes here.", 0, "Ann writes".length);
      await a.locator(".bubble").click({ timeout: 5000 });
      await a.locator("textarea").first().fill("Who is Ann?", { timeout: 5000 });
      await a.keyboard.press(SUBMIT);
      await expect.poll(() => markedText(b), { timeout: 10_000 }).toBe("Ann writes");
      const status = async () =>
        (await server.db.commentThread.findFirstOrThrow({ where: { documentId }, select: { status: true } })).status;
      // Bo deletes the commented words: the comment is outdated.
      await select(b, "Ann writes here.", 0, "Ann writes here.".length);
      await b.keyboard.press("Backspace");
      await expect.poll(status, { timeout: 15_000 }).toBe("outdated");
      // Bo undoes: the words are back, and so is the comment, for everyone.
      await b.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => editorText(a), { timeout: 10_000 }).toContain("Ann writes here.");
      await expect.poll(status, { timeout: 15_000 }).toBe("open");
      await expect.poll(() => markedText(a), { timeout: 10_000 }).toBe("Ann writes");
    }, 60_000);

    it("a person with comment access sees edits live but cannot type", async () => {
      const { documentId, cookie, ownerCookie } = await server.design({
        kind: "document",
        title: "Plan",
        markdown: MD,
        access: "comment",
      });
      const owner = await open(ownerCookie, documentId);
      const reader = await open(cookie, documentId);
      await select(owner, "Bo writes here.", "Bo writes here.".length);
      await owner.keyboard.type(" OWNER-EDIT");
      await expect.poll(() => editorText(reader), { timeout: 10_000 }).toContain("OWNER-EDIT");
      expect(await reader.locator(".ProseMirror").getAttribute("contenteditable")).toBe("false");
    }, 60_000);

    it("a document with formatting the editor cannot keep opens comment-only, not live", async () => {
      const { documentId, cookie } = await server.design({
        kind: "document",
        title: "Lossy",
        markdown: "# Plan\n\nAnn writes here.\n\n![diagram](https://example.com/d.png)\n",
        access: "write",
      });
      const a = await open(cookie, documentId);
      await expect.poll(() => a.locator(".save").innerText()).not.toContain("Live");
      expect(await a.locator(".ProseMirror").getAttribute("contenteditable")).toBe("false");
      expect(await server.db.documentLiveState.count({ where: { documentId } })).toBe(0);
    }, 60_000);
  },
);
