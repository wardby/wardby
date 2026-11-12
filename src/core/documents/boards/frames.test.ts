import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { frameHtml } from "./frames.js";

const board =
  "<!doctype html><html><head><title>x</title><style data-wardby-base>a{color:red}</style></head><body>" +
  '<a href="#board:menu">Menu</a><a href="#board:gone">Gone</a><a href="https://example.com">Out</a><a href="#top">Top</a></body></html>';

describe("frameHtml", () => {
  it("play: board links target the parent fragment; every other link is inert", () => {
    const d = new JSDOM(frameHtml(board, "play", new Set(["home", "menu"]))).window.document;
    const [menu, gone, out, top] = Array.from(d.querySelectorAll("a"));
    expect(menu.getAttribute("href")).toBe("#board-menu");
    expect(menu.getAttribute("target")).toBe("_top");
    for (const a of [gone, out, top]) {
      expect(a.hasAttribute("href")).toBe(false);
      expect(a.hasAttribute("target")).toBe(false);
    }
    expect(d.querySelector("style[data-wardby-base]")?.textContent).toBe("a{color:red}");
  });

  it("overview: no link keeps an href", () => {
    const d = new JSDOM(frameHtml(board, "overview", new Set(["menu"]))).window.document;
    expect(Array.from(d.querySelectorAll("a")).some((a) => a.hasAttribute("href"))).toBe(false);
  });

  it("drops a target the board set itself, and image-map areas follow the same rule", () => {
    const html =
      '<!doctype html><html><body><a href="#board:menu" target="_blank">M</a>' +
      '<map name="m"><area href="#board:menu" target="_parent"><area href="/x"></map>' +
      '<a href="#board:MENU">upper</a></body></html>';
    const d = new JSDOM(frameHtml(html, "play", new Set(["menu"]))).window.document;
    const a = d.querySelector("a")!;
    expect(a.getAttribute("target")).toBe("_top");
    const [area1, area2] = Array.from(d.querySelectorAll("area"));
    expect(area1.getAttribute("href")).toBe("#board-menu");
    expect(area1.getAttribute("target")).toBe("_top");
    expect(area2.hasAttribute("href")).toBe(false);
    expect(d.querySelectorAll("a")[1].hasAttribute("href")).toBe(false);
  });

  it("SVG links: an external xlink:href is removed in both modes; a #board: xlink link is rewritten", () => {
    const html =
      '<!doctype html><html><body><svg xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' +
      '<a xlink:href="https://evil.example/"><text>out</text></a>' +
      '<a xlink:href="#board:menu"><text>menu</text></a>' +
      '<a href="https://evil.example/" xlink:href="https://evil.example/2"><text>both</text></a></svg></body></html>';
    for (const mode of ["play", "overview"] as const) {
      const out = frameHtml(html, mode, new Set(["menu"]));
      expect(out).not.toContain("evil.example");
      expect(out).not.toContain("xlink:href");
      const links = Array.from(new JSDOM(out).window.document.querySelectorAll("a"));
      expect(links).toHaveLength(3);
      if (mode === "play") {
        expect(links[1].getAttribute("href")).toBe("#board-menu");
        expect(links[1].getAttribute("target")).toBe("_top");
      } else {
        expect(links.some((a) => a.hasAttribute("href"))).toBe(false);
      }
      expect(links[0].hasAttribute("href")).toBe(false);
      expect(links[2].hasAttribute("href")).toBe(false);
    }
  });
});
