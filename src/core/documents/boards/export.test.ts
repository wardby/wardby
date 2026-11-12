import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { exportSlug, prototypeFile, SWITCHER_SCRIPT } from "./export.js";

describe("prototype export", () => {
  const boards = [
    {
      id: "home",
      name: "Home",
      width: 1280,
      html: '<!doctype html><body><a href="#board-menu" target="_top">Menu</a></body>',
    },
    { id: "menu", name: "</script><script>alert(1)</script>", width: 1280, html: "<!doctype html><body>Menu</body>" },
  ];
  it("holds exactly one runnable script, allowed by its hash, and the boards as inert JSON", () => {
    const html = prototypeFile({ title: "Coffee", boards });
    const doc = new JSDOM(html).window.document;
    const scripts = Array.from(doc.querySelectorAll("script"));
    expect(scripts.map((s) => s.getAttribute("type") ?? "")).toEqual(["application/json", ""]);
    expect(JSON.parse(scripts[0].textContent!)).toEqual(boards);
    expect(scripts[1].textContent).toBe(SWITCHER_SCRIPT);
    const hash = createHash("sha256").update(SWITCHER_SCRIPT).digest("base64");
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")).toContain(
      `'sha256-${hash}'`,
    );
    expect(doc.querySelector("iframe")!.getAttribute("sandbox")).toBe(
      "allow-same-origin allow-top-navigation-by-user-activation",
    );
  });
  it("slugs titles to safe file names", () => {
    expect(exportSlug("Little Fern Coffee!")).toBe("little-fern-coffee");
    expect(exportSlug("…")).toBe("design");
    expect(exportSlug("…", "document")).toBe("document");
  });
});
