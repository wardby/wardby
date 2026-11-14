/**
 * Document review on the Markdown and design pages in headless Chromium, against the real server and
 * bundle (run `npm run build` first). Skipped without DATABASE_URL or a Playwright Chromium.
 */
import { existsSync, readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishVersion } from "../core/documents/service.js";
import { reopenDocument, reviewDocument, submitForReview } from "../core/documents/review.js";
import { startTestWebServer, TEST_CIPHER, type BrowserCookie, type TestWebServer } from "./test-server.test-support.js";

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
      await context.close();
    }, 90_000);

    it("a design approved while open stops saving and says to reload", async () => {
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
        .toContain("This design was approved, so it can't be edited now. Reload to see it read-only.");
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
