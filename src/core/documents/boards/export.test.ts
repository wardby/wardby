import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { exportSlug, prototypeFile, SWITCHER_SCRIPT } from "./export.js";

/**
 * Ruling T9-1: the board frame keeps allow-same-origin only because it has no allow-scripts and the
 * file's CSP runs no script but the switcher (by hash). Loosening either one alone must fail here.
 */
function expectInertPrototype(html: string): void {
  const doc = new JSDOM(html).window.document;
  const frames = Array.from(doc.querySelectorAll("iframe"));
  expect(frames).toHaveLength(1);
  const tokens = (frames[0].getAttribute("sandbox") ?? "").trim().split(/\s+/).sort();
  expect(tokens).toEqual(["allow-same-origin", "allow-top-navigation-by-user-activation"]);
  expect(tokens).not.toContain("allow-scripts");
  const metas = Array.from(doc.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]'));
  expect(metas).toHaveLength(1);
  const directives = new Map(
    metas[0]
      .getAttribute("content")!
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...values]) => [name.toLowerCase(), values]),
  );
  const hash = createHash("sha256").update(SWITCHER_SCRIPT).digest("base64");
  expect(directives.get("default-src")).toEqual(["'none'"]);
  expect(directives.get("script-src")).toEqual([`'sha256-${hash}'`]);
  expect(directives.has("script-src-elem")).toBe(false);
  expect(directives.has("script-src-attr")).toBe(false);
}

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
  it("pins ruling T9-1: a same-origin board frame without allow-scripts, and only the switcher's hash may run", () => {
    expectInertPrototype(prototypeFile({ title: "Coffee", boards }));
  });
  it("slugs titles to safe file names", () => {
    expect(exportSlug("Little Fern Coffee!")).toBe("little-fern-coffee");
    expect(exportSlug("…")).toBe("design");
    expect(exportSlug("…", "document")).toBe("document");
  });
});
