/**
 * Document review on the Markdown and design pages in headless Chromium, against the real server and
 * bundle (run `npm run build` first). Skipped without DATABASE_URL or a Playwright Chromium.
 */
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishVersion } from "../core/documents/service.js";
import { reviewDocument, submitForReview } from "../core/documents/review.js";
import { startTestWebServer, TEST_CIPHER, type BrowserCookie, type TestWebServer } from "./test-server.test-support.js";

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
  },
);
