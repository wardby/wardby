/**
 * Document review on the Markdown and design pages in headless Chromium, against the real server and
 * bundle (run `npm run build` first). Skipped without DATABASE_URL or a Playwright Chromium.
 */
import { existsSync, readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createThread } from "../core/documents/comments.js";
import { publishVersion } from "../core/documents/service.js";
import { reopenDocument, reviewDocument, setArchived, submitForReview } from "../core/documents/review.js";
import { startTestWebServer, TEST_CIPHER, type BrowserCookie, type TestWebServer } from "./test-server.test-support.js";

const CANVAS = "iframe.gjs-frame";
const SUBMIT = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
const coffee = (p: string) =>
  readFileSync(new URL(`../core/documents/boards/fixtures/coffee/${p}`, import.meta.url), "utf8");
const files = (): Record<string, string> => ({
  "manifest.json": coffee("manifest.json"),
  ...Object.fromEntries(
    ["home", "menu", "about", "visit"].map((id) => [`boards/${id}.html`, coffee(`boards/${id}.html`)]),
  ),
});

describe.skipIf(!process.env.DATABASE_URL || !existsSync(chromium.executablePath()))(
  "document review (browser)",
  () => {
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

    const open = async (cookie: BrowserCookie, documentId: string): Promise<Page> => {
      const context = await browser.newContext();
      await context.addCookies([cookie]);
      const page = await context.newPage();
      await page.goto(`${server.origin}/d/${documentId}`);
      await expect.poll(() => page.locator(".review-banner").textContent(), { timeout: 20_000 }).toMatch(/v\d/);
      return page;
    };
    const banner = (p: Page) => p.locator(".review-banner").textContent();
    const editable = (p: Page) => p.locator(".editor .ProseMirror").getAttribute("contenteditable");
    const owner = (ids: { owner: string }) => ({ kind: "principal" as const, principalId: ids.owner });

    it("the owner submits from the page; reviewers approve; the editor locks and reopens", async () => {
      const d = await server.design({
        title: "Plan",
        kind: "document",
        markdown: "# Plan\n\nhello\n",
        access: "comment",
      });
      const o = await open(d.ownerCookie, d.documentId);
      expect(await banner(o)).toContain("Draft · v1");
      await o.getByRole("tab", { name: "Review" }).click();
      await o.getByRole("button", { name: "Submit for review" }).click();
      await o.getByRole("checkbox", { name: "Ada Member" }).check();
      await o.getByRole("checkbox", { name: "Bo Member" }).check();
      await o.locator(".rv-form").getByRole("button", { name: "Submit for review" }).click();
      await expect.poll(() => banner(o)).toContain("In review · v1 · 0 of 2 approved");
      expect(await o.locator(".rv-reviewers li").allTextContents()).toEqual([
        expect.stringContaining("Waiting"),
        expect.stringContaining("Waiting"),
      ]);

      const a = await open(d.cookie, d.documentId);
      await a.getByRole("tab", { name: "Review" }).click();
      await a.getByRole("textbox", { name: "Review note" }).fill("Looks right");
      await a.getByRole("button", { name: "Approve", exact: true }).click();
      await expect.poll(() => banner(o)).toContain("1 of 2 approved");
      await reviewDocument(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        viewer: { kind: "principal", principalId: d.principalIds.second },
        verdict: "approve",
        versionNumber: 1,
      });
      await expect.poll(() => banner(o)).toContain("Approved · v1 · 2 of 2 approved");
      await expect.poll(() => editable(o)).toBe("false");
      expect(await o.locator(".toolbar").isVisible()).toBe(false);
      await o.getByRole("button", { name: "Reopen for review" }).click();
      await expect.poll(() => banner(o)).toContain("In review");
      await expect.poll(() => editable(o)).toBe("true");
    }, 90_000);

    it("a reviewer is offered only the verdict they have not given: once approved, only Request changes on vN", async () => {
      const d = await server.design({ title: "Offer", kind: "document", markdown: "# O\n\nx\n", access: "comment" });
      await submitForReview(server.db, {
        documentId: d.documentId,
        viewer: owner(d.principalIds),
        reviewers: [d.principalIds.first],
      });
      await reviewDocument(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        viewer: { kind: "principal", principalId: d.principalIds.first },
        verdict: "approve",
        versionNumber: 1,
      });
      const a = await open(d.cookie, d.documentId);
      expect(await banner(a)).toContain("Approved · v1");
      await a.getByRole("tab", { name: "Review" }).click();
      const verdicts = a.locator(".rv-panel .rv-verdict");
      expect(await verdicts.getByRole("button").allTextContents()).toEqual(["Request changes on v1"]);
      expect(await verdicts.textContent()).toContain("You approved v1");
      await verdicts.getByRole("button", { name: "Request changes on v1" }).click();
      await expect.poll(() => banner(a)).toContain("Changes requested · v1");
      await expect.poll(() => verdicts.getByRole("button").allTextContents()).toEqual(["Approve"]);
      expect(await verdicts.textContent()).toContain("You requested changes on v1");
    }, 90_000);

    it("an outdated thread takes a reply from the page", async () => {
      const d = await server.design({
        title: "Out",
        kind: "document",
        markdown: "# O\n\nhello world\n",
        access: "comment",
      });
      const t = await createThread(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        viewer: owner(d.principalIds),
        anchor: { type: "text", quote: "hello world", prefix: "", suffix: "" },
        body: "Is this right?",
      });
      const out = await publishVersion(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        markdown: "# O\n\nsomething else\n",
        via: "mcp",
      });
      expect(out.reanchored).toEqual({ kept: 0, outdated: 1 });
      const a = await open(d.cookie, d.documentId);
      const row = a.locator(".tp-row", { hasText: "Is this right?" });
      await expect.poll(() => row.locator(".chip.out").count(), { timeout: 10_000 }).toBe(1);
      await row.click();
      await a.locator(".cpop textarea").fill("Still worth asking");
      await a.locator(".cpop textarea").press(SUBMIT);
      await expect.poll(() => a.locator(".cpop").textContent(), { timeout: 10_000 }).toContain("Still worth asking");
      expect(await a.locator(".cpop [role=alert]").count()).toBe(0);
      const bodies = await server.db.comment.findMany({
        where: { threadId: t.threadId },
        orderBy: { createdAt: "asc" },
      });
      expect(bodies.map((c) => c.body)).toEqual(["Is this right?", "Still worth asking"]);
    }, 90_000);

    it("force approve lists who it overrides and needs a note", async () => {
      const d = await server.design({ title: "Force", kind: "document", markdown: "# F\n\nx\n", access: "comment" });
      await submitForReview(server.db, {
        documentId: d.documentId,
        viewer: owner(d.principalIds),
        reviewers: [d.principalIds.first, d.principalIds.second],
      });
      await reviewDocument(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        viewer: { kind: "principal", principalId: d.principalIds.first },
        verdict: "request_changes",
        versionNumber: 1,
      });
      const o = await open(d.ownerCookie, d.documentId);
      await o.getByRole("tab", { name: "Review" }).click();
      await o.getByRole("button", { name: "Force approve" }).click();
      expect(await o.locator(".rv-pending li").allTextContents()).toEqual([
        "Ada Member has requested changes on v1",
        "Bo Member has not reviewed v1",
      ]);
      const confirm = o.locator(".rv-form").getByRole("button", { name: "Force approve" });
      expect(await confirm.isDisabled()).toBe(true);
      await o.getByRole("textbox", { name: "Force approve note" }).fill("Deadline");
      await confirm.click();
      await expect
        .poll(() => banner(o))
        .toContain(
          "Approved (forced by Olive Owner) · Ada Member had requested changes on v1 · Bo Member had not reviewed v1",
        );
    }, 90_000);

    it("a newer version while reviewing: Review vN shows the changes; a lost race keeps the note and one click approves vN", async () => {
      const d = await server.design({
        title: "Newer",
        kind: "document",
        markdown: "# N\n\nfirst\n",
        access: "comment",
      });
      await submitForReview(server.db, {
        documentId: d.documentId,
        viewer: owner(d.principalIds),
        reviewers: [d.principalIds.first],
      });
      const a = await open(d.cookie, d.documentId);
      await publishVersion(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        markdown: "# N\n\nsecond\n",
        via: "mcp",
      });
      await expect.poll(() => banner(a)).toContain("v2 was published while you were reviewing v1");
      await a.getByRole("tab", { name: "Review" }).click();
      await a.getByRole("button", { name: "Review v2" }).click();
      await expect.poll(() => a.locator(".vbar").textContent()).toContain("Viewing v2 — changes since v1");

      // Lose the race: no live events reach this page, a v3 lands, then the reviewer approves v2.
      await a.route("**/events", (r) => r.abort());
      await a.reload();
      await expect.poll(() => banner(a)).toContain("v2");
      await publishVersion(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        markdown: "# N\n\nthird\n",
        via: "mcp",
      });
      await a.getByRole("tab", { name: "Review" }).click();
      await a.getByRole("textbox", { name: "Review note" }).first().fill("Keep this note");
      await a.getByRole("button", { name: "Approve", exact: true }).click();
      await expect
        .poll(() => banner(a))
        .toContain("v3 was published just before your approval, so it wasn't recorded. Here's what changed.");
      await expect.poll(() => a.locator(".vbar").textContent()).toContain("Viewing v3 — changes since v2");
      expect(await a.getByRole("textbox", { name: "Review note" }).first().inputValue()).toBe("Keep this note");
      await a.getByRole("button", { name: "Approve v3" }).first().click();
      await expect.poll(() => banner(a)).toContain("Approved · v3");
      const row = await server.db.documentReviewer.findFirstOrThrow({ where: { documentId: d.documentId } });
      expect([row.verdict, row.versionNumber, row.note]).toEqual(["approved", 3, "Keep this note"]);
    }, 90_000);

    it("a Markdown save refused as locked keeps the edits unsaved: no retry on a timer, the next edit saves them", async () => {
      const d = await server.design({ title: "Lock", kind: "document", markdown: "# L\n\nfirst\n", access: "write" });
      const context = await browser.newContext();
      await context.addCookies([d.cookie]);
      const page = await context.newPage();
      // The first save is refused as locked (approved and reopened inside one save cycle).
      let refused = 0;
      await page.route(
        (url) => url.pathname.startsWith("/d/api/"),
        async (route) => {
          if (route.request().method() === "PUT" && refused === 0) {
            refused += 1;
            return route.fulfill({
              status: 409,
              contentType: "application/json",
              body: JSON.stringify({ error: "document_locked" }),
            });
          }
          return route.fallback();
        },
      );
      const puts: string[] = [];
      page.on("request", (r) => r.method() === "PUT" && puts.push(r.postData() ?? ""));
      await page.goto(`${server.origin}/d/${d.documentId}`);
      await expect.poll(() => editable(page), { timeout: 20_000 }).toBe("true");
      const save = () => page.locator(".save").textContent();
      await page.locator(".editor .ProseMirror p").click();
      await page.keyboard.press("End");
      await page.keyboard.type(" one");
      await expect.poll(() => refused, { timeout: 10_000 }).toBe(1);
      await expect.poll(() => save()).toBe("Unsaved changes");
      await page.waitForTimeout(2500);
      expect(puts.length).toBe(1);
      await page.keyboard.type(" two");
      await expect.poll(() => puts.length, { timeout: 10_000 }).toBe(2);
      expect(puts[1]).toContain("first one two");
      await expect.poll(() => save(), { timeout: 10_000 }).toBe("Saved");
      await context.close();
    }, 90_000);

    it("a Markdown page approved while typing saves nothing while locked; after a reopen the edits wait for the next edit", async () => {
      const d = await server.design({ title: "Lock", kind: "document", markdown: "# L\n\nfirst\n", access: "write" });
      await submitForReview(server.db, {
        documentId: d.documentId,
        viewer: owner(d.principalIds),
        reviewers: [d.principalIds.second],
      });
      const context = await browser.newContext();
      await context.addCookies([d.cookie]);
      const page = await context.newPage();
      const puts: string[] = [];
      page.on("request", (r) => r.method() === "PUT" && puts.push(r.postData() ?? ""));
      await page.goto(`${server.origin}/d/${d.documentId}`);
      await expect.poll(() => editable(page), { timeout: 20_000 }).toBe("true");
      const save = () => page.locator(".save").textContent();
      await page.locator(".editor .ProseMirror p").click();
      await page.keyboard.press("End");
      await page.keyboard.type(" one");
      // The approval lands inside the save delay, while the edit is still unsaved.
      await reviewDocument(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        viewer: { kind: "principal", principalId: d.principalIds.second },
        verdict: "approve",
        versionNumber: 1,
      });
      await expect.poll(() => save()).toBe("Read only: approved · unsaved changes");
      await page.waitForTimeout(2500);
      expect(puts).toEqual([]);

      await reopenDocument(server.db, { documentId: d.documentId, viewer: owner(d.principalIds) });
      await expect.poll(() => save()).toBe("Unsaved changes");
      await page.waitForTimeout(2500);
      expect(puts).toEqual([]);
      await page.locator(".editor .ProseMirror p").click();
      await page.keyboard.press("End");
      await page.keyboard.type(" two");
      await expect.poll(() => puts.length, { timeout: 10_000 }).toBe(1);
      expect(puts[0]).toContain("first one two");
      await expect.poll(() => save(), { timeout: 10_000 }).toBe("Saved");
      await context.close();
    }, 90_000);

    it("an approved document offers no Restore; reopening gives each viewer back their own save state", async () => {
      const d = await server.design({ title: "Lock", kind: "document", markdown: "# L\n\nfirst\n", access: "comment" });
      await publishVersion(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        markdown: "# L\n\nsecond\n",
        via: "mcp",
      });
      await submitForReview(server.db, {
        documentId: d.documentId,
        viewer: owner(d.principalIds),
        reviewers: [d.principalIds.first],
      });
      const save = (p: Page) => p.locator(".save").textContent();
      const o = await open(d.ownerCookie, d.documentId);
      const a = await open(d.cookie, d.documentId);
      expect(await save(o)).toBe("Saved");
      expect(await save(a)).toBe("Comment only");
      await reviewDocument(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        viewer: { kind: "principal", principalId: d.principalIds.first },
        verdict: "approve",
        versionNumber: 2,
      });
      await expect.poll(() => save(o)).toBe("Read only: approved");
      await expect.poll(() => save(a)).toBe("Read only: approved");
      // Opened while approved: the same text from the start.
      const later = await open(d.secondCookie, d.documentId);
      expect(await save(later)).toBe("Read only: approved");
      await later.context().close();
      const viewV1 = async () => {
        await o.getByRole("tab", { name: "Edits" }).click();
        await expect.poll(() => o.locator(".ed-row").count()).toBe(2);
        await o.locator(".ed-row").last().click();
        await expect.poll(() => o.locator(".vbar").textContent()).toContain("Viewing v1");
      };
      await viewV1();
      expect(await o.getByRole("button", { name: "Restore this version" }).count()).toBe(0);
      await o.getByRole("button", { name: "Back to latest" }).click();

      await reopenDocument(server.db, { documentId: d.documentId, viewer: owner(d.principalIds) });
      await expect.poll(() => save(o)).toBe("Saved");
      await expect.poll(() => save(a)).toBe("Comment only");
      await viewV1();
      expect(await o.getByRole("button", { name: "Restore this version" }).count()).toBe(1);
    }, 90_000);

    it("an approved design opens read-only: no Style tab, no save, Send hidden, comments still work", async () => {
      const d = await server.design({ title: "Coffee", files: files(), access: "write" });
      // Linked, so it could be sent to an agent: only the lock hides Send.
      await server.db.document.update({
        where: { id: d.documentId },
        data: { repository: "acme/web", path: "designs/coffee", baseRef: "main" },
      });
      await submitForReview(server.db, {
        documentId: d.documentId,
        viewer: owner(d.principalIds),
        reviewers: [d.principalIds.first],
      });
      await reviewDocument(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        viewer: { kind: "principal", principalId: d.principalIds.first },
        verdict: "approve",
        versionNumber: 1,
      });
      const context = await browser.newContext();
      await context.addCookies([d.cookie]);
      const page = await context.newPage();
      const puts: string[] = [];
      page.on("request", (r) => r.method() === "PUT" && puts.push(r.url()));
      await page.goto(`${server.origin}/d/${d.documentId}`);
      const h1 = page.frameLocator(CANVAS).locator("h1").first();
      await expect.poll(() => h1.textContent(), { timeout: 20_000 }).toMatch(/\S/);
      expect(await banner(page)).toContain("Approved · v1");
      expect(await page.locator("[data-tab=style]").isVisible()).toBe(false);
      await h1.dblclick();
      await page.keyboard.type("x");
      await page.waitForTimeout(2500);
      expect(puts).toEqual([]);
      expect(await page.locator("[data-tab=review]").isVisible()).toBe(true);
      // A comment can still be posted, and the composer offers no Send to agent.
      await page.locator(".save").click();
      await page.keyboard.press("c");
      const created = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/threads"));
      await h1.click();
      await expect.poll(() => page.locator(".cpop textarea").count()).toBe(1);
      expect(await page.locator(".cpop label", { hasText: "Send to agent" }).isVisible()).toBe(false);
      await page.locator(".cpop textarea").fill("Looks good");
      await page.locator(".cpop textarea").press(SUBMIT);
      expect((await created).status()).toBe(201);
      await expect.poll(() => page.locator(".pin").count(), { timeout: 10_000 }).toBeGreaterThan(0);
      // Opened read-only, then reopened: a reload is needed to edit it.
      await page.keyboard.press("Escape");
      await reopenDocument(server.db, { documentId: d.documentId, viewer: owner(d.principalIds) });
      await expect
        .poll(() => page.locator(".lock-banner").textContent(), { timeout: 10_000 })
        .toBe("This design was reopened for review. Reload to edit it. Reload");
      expect(await page.locator(".lock-banner button", { hasText: "Reload" }).isVisible()).toBe(true);
      await context.close();
    }, 90_000);

    it("a design approved while open is read-only in place; the state word follows; reopening saves nothing on its own", async () => {
      const d = await server.design({ title: "Coffee", files: files(), access: "write" });
      await submitForReview(server.db, {
        documentId: d.documentId,
        viewer: owner(d.principalIds),
        reviewers: [d.principalIds.second],
      });
      const page = await (async () => {
        const context = await browser.newContext();
        await context.addCookies([d.cookie]);
        return context.newPage();
      })();
      const puts: string[] = [];
      page.on("request", (r) => r.method() === "PUT" && puts.push(r.url()));
      await page.goto(`${server.origin}/d/${d.documentId}`);
      await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
      const canvas = page.frameLocator(CANVAS);
      const h1 = canvas.locator("h1").first();
      const before = await h1.textContent();
      const h1s = await canvas.locator("h1").count();
      // Typing in the heading when the approval lands.
      await h1.dblclick();
      await reviewDocument(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        viewer: { kind: "principal", principalId: d.principalIds.second },
        verdict: "approve",
        versionNumber: 1,
      });
      const save = () => page.locator(".save").textContent();
      await expect.poll(() => save()).toBe("Read only: approved");
      // Locked live looks like locked at load: no undo or redo, no Layers.
      expect(await page.getByRole("button", { name: "Undo" }).isVisible()).toBe(false);
      expect(await page.getByRole("heading", { name: "Layers" }).isVisible()).toBe(false);
      // The canvas takes no edits: typing (on, and after a new double click), then deleting the selected element.
      await page.keyboard.type("x");
      await h1.dblclick();
      await page.keyboard.type("x");
      await h1.click();
      // Selected while locked: its toolbar keeps no move, copy or delete.
      const moveTool = page.locator(".gjs-toolbar .gjs-toolbar-item.gjs-no-touch-actions");
      await expect.poll(() => page.locator(".gjs-toolbar [title=Comment]").count()).toBe(1);
      expect(await moveTool.count()).toBe(0);
      await page.keyboard.press("Delete");
      await page.keyboard.press("Backspace");
      expect(await h1.textContent()).toBe(before);
      expect(await canvas.locator("h1").count()).toBe(h1s);
      // The canvas still scrolls and takes comments: the pin mode starts.
      await page.locator(".save").click();
      await page.keyboard.press("c");
      await expect.poll(() => page.getByText("Click anything on the board to comment").isVisible()).toBe(true);
      await page.keyboard.press("Escape");

      // Archived, then back to approved: the word follows each state.
      await setArchived(server.db, { documentId: d.documentId, viewer: owner(d.principalIds), archived: true });
      await expect.poll(() => save()).toBe("Read only: archived");
      await setArchived(server.db, { documentId: d.documentId, viewer: owner(d.principalIds), archived: false });
      await expect.poll(() => save()).toBe("Read only: approved");

      // Reopened: editable again, and nothing was published on a timer.
      await reopenDocument(server.db, { documentId: d.documentId, viewer: owner(d.principalIds) });
      await expect.poll(() => save()).toBe("Saved");
      expect(await page.locator(".lock-banner").isVisible()).toBe(false);
      expect(await page.getByRole("button", { name: "Undo" }).isVisible()).toBe(true);
      await page.waitForTimeout(2500);
      expect(puts).toEqual([]);
      expect(await h1.textContent()).toBe(before);
      // The element selected while locked gets its full toolbar back: move, copy and delete, and 💬.
      await h1.click();
      await expect.poll(() => moveTool.count()).toBe(1);
      expect(await page.locator(".gjs-toolbar .gjs-toolbar-item").count()).toBe(5);
      expect(await page.locator(".gjs-toolbar [title=Comment]").count()).toBe(1);
      // The next edit saves.
      await h1.dblclick();
      await page.keyboard.press("End");
      await page.keyboard.type("!");
      await page.locator(".save").click();
      await expect.poll(() => puts.length, { timeout: 10_000 }).toBe(1);
      await page.context().close();
    }, 90_000);

    it("a save refused as locked, when the refetch finds it open again, keeps the edits unsaved until the next edit", async () => {
      const d = await server.design({ title: "Coffee", files: files(), access: "write" });
      const context = await browser.newContext();
      await context.addCookies([d.cookie]);
      const page = await context.newPage();
      // The first save is refused as locked (approved and reopened inside one save cycle).
      let refused = 0;
      await page.route(
        (url) => url.pathname.startsWith("/d/api/"),
        async (route) => {
          if (route.request().method() === "PUT" && refused === 0) {
            refused += 1;
            return route.fulfill({
              status: 409,
              contentType: "application/json",
              body: JSON.stringify({ error: "document_locked" }),
            });
          }
          return route.fallback();
        },
      );
      const puts: string[] = [];
      page.on("request", (r) => r.method() === "PUT" && puts.push(r.url()));
      await page.goto(`${server.origin}/d/${d.documentId}`);
      await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
      const h1 = page.frameLocator(CANVAS).locator("h1").first();
      await h1.dblclick();
      await page.keyboard.press("End");
      await page.keyboard.type("!");
      await page.locator(".save").click();
      const save = () => page.locator(".save").textContent();
      await expect.poll(() => refused, { timeout: 10_000 }).toBe(1);
      await expect.poll(() => save()).toBe("Unsaved changes");
      await page.waitForTimeout(2500);
      expect(puts.length).toBe(1);
      await h1.dblclick();
      await page.keyboard.press("End");
      await page.keyboard.type("?");
      await page.locator(".save").click();
      await expect.poll(() => puts.length, { timeout: 10_000 }).toBe(2);
      await expect.poll(() => save(), { timeout: 10_000 }).toBe("Saved");
      await context.close();
    }, 90_000);

    it("a design's Review vN shows the boards changed since the version the reviewer read, not just the last step", async () => {
      const d = await server.design({ title: "Coffee", files: files(), access: "comment" });
      await submitForReview(server.db, {
        documentId: d.documentId,
        viewer: owner(d.principalIds),
        reviewers: [d.principalIds.first],
      });
      const page = await open(d.cookie, d.documentId);
      const menu = files()["boards/menu.html"].replace("</body>", "<p>v2</p></body>");
      await publishVersion(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        files: { ...files(), "boards/menu.html": menu },
        via: "mcp",
      });
      const home = files()["boards/home.html"].replace("</body>", "<p>v3</p></body>");
      await publishVersion(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        files: { ...files(), "boards/menu.html": menu, "boards/home.html": home },
        via: "mcp",
      });
      await expect.poll(() => banner(page)).toContain("v3 was published while you were reviewing v1");
      await page.getByRole("tab", { name: "Review" }).click();
      await page.getByRole("button", { name: "Review v3" }).click();
      await expect.poll(() => page.locator(".vbar").textContent()).toContain("Viewing v3 — changes since v1");
      const changed = page.locator(".vv-boards [data-changed]");
      expect(await changed.evaluateAll((els) => els.map((e) => e.getAttribute("data-board")))).toEqual([
        "home",
        "menu",
      ]);
      await page.context().close();
    }, 90_000);

    it("a design's edits from before a lock survive a reopen and a newer version: the changed banner shows", async () => {
      const d = await server.design({ title: "Coffee", files: files(), access: "write" });
      await submitForReview(server.db, {
        documentId: d.documentId,
        viewer: owner(d.principalIds),
        reviewers: [d.principalIds.second],
      });
      const context = await browser.newContext();
      await context.addCookies([d.cookie]);
      const page = await context.newPage();
      // While `held` is set, the page's refetches wait, so one refetch sees the reopen and the new version together.
      let release: () => void = () => undefined;
      let held: Promise<void> | null = null;
      await page.route(
        (url) => url.pathname === `/d/api/${d.documentId}`,
        async (route) => {
          if (route.request().method() === "GET" && held) await held;
          return route.fallback();
        },
      );
      const puts: string[] = [];
      page.on("request", (r) => r.method() === "PUT" && puts.push(r.url()));
      await page.goto(`${server.origin}/d/${d.documentId}`);
      await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
      const h1 = page.frameLocator(CANVAS).locator("h1").first();
      // Still typing (nothing is saved while text is being edited) when the approval lands.
      await h1.dblclick();
      await page.keyboard.press("End");
      await page.keyboard.type("!");
      await reviewDocument(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        viewer: { kind: "principal", principalId: d.principalIds.second },
        verdict: "approve",
        versionNumber: 1,
      });
      const save = () => page.locator(".save").textContent();
      await expect.poll(() => save()).toBe("Read only: approved · unsaved changes");
      expect(puts).toEqual([]);
      const typed = await h1.textContent();
      expect(typed).toContain("!");

      held = new Promise<void>((r) => (release = r));
      await reopenDocument(server.db, { documentId: d.documentId, viewer: owner(d.principalIds) });
      const home = files()["boards/home.html"].replace("</body>", "<p>v2</p></body>");
      await publishVersion(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        files: { ...files(), "boards/home.html": home },
        via: "mcp",
      });
      await page.waitForTimeout(500);
      held = null;
      release();
      await expect.poll(() => page.getByText("This design changed.").isVisible()).toBe(true);
      await expect.poll(() => save()).toBe("Unsaved changes");
      expect(await h1.textContent()).toBe(typed);
      expect(await page.locator(".version").textContent()).toBe("design · v1");
      expect(puts).toEqual([]);
      await context.close();
    }, 90_000);

    it("a design approved while open stops saving and says it is read-only now, with no Reload", async () => {
      const d = await server.design({ title: "Coffee", files: files(), access: "write" });
      await submitForReview(server.db, {
        documentId: d.documentId,
        viewer: owner(d.principalIds),
        reviewers: [d.principalIds.second],
      });
      const context = await browser.newContext();
      await context.addCookies([d.cookie]);
      const page = await context.newPage();
      await page.goto(`${server.origin}/d/${d.documentId}`);
      await expect.poll(() => page.locator("[data-fidelity-done]").count(), { timeout: 20_000 }).toBe(1);
      await reviewDocument(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        viewer: { kind: "principal", principalId: d.principalIds.second },
        verdict: "approve",
        versionNumber: 1,
      });
      await expect
        .poll(() => page.locator(".lock-banner").textContent())
        .toBe("This design was approved, so it's read-only now. Reopen it for review to edit it.");
      expect(await page.locator(".lock-banner button").count()).toBe(0);
      expect(await page.locator("[data-tab=style]").isVisible()).toBe(false);
      await context.close();
    }, 90_000);

    it("an approved design's History offers no Restore", async () => {
      const d = await server.design({ title: "Coffee", files: files(), access: "write" });
      const home = files()["boards/home.html"].replace("</body>", "<p>v2</p></body>");
      await publishVersion(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        files: { ...files(), "boards/home.html": home },
        via: "mcp",
      });
      await submitForReview(server.db, {
        documentId: d.documentId,
        viewer: owner(d.principalIds),
        reviewers: [d.principalIds.second],
      });
      await reviewDocument(server.db, TEST_CIPHER, {
        documentId: d.documentId,
        viewer: { kind: "principal", principalId: d.principalIds.second },
        verdict: "approve",
        versionNumber: 2,
      });
      const page = await open(d.cookie, d.documentId);
      expect(await page.locator(".save").textContent()).toBe("Read only: approved");
      await page.locator("[data-tab=history]").click();
      await page.locator('.tp-row[data-version="1"]').click();
      await expect.poll(() => page.locator(".vbar").textContent()).toContain("Viewing v1");
      expect(await page.getByRole("button", { name: "Restore this version" }).count()).toBe(0);
      await page.context().close();
    }, 90_000);
  },
);
