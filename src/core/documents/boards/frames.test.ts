import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { clearFrameCache, FRAME_CACHE_MAX_ENTRIES, frameCacheSize, frameHtml, versionFrames } from "./frames.js";

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

describe("versionFrames (per-version cache)", () => {
  afterEach(() => clearFrameCache());
  const entries = [
    { id: "home", name: "Home", width: 1280, file: "boards/home.html" },
    { id: "menu", name: "Menu", width: 1280, file: "boards/menu.html" },
    { id: "lost", name: "Lost", width: 1280, file: "boards/lost.html" },
  ];
  const files = { "boards/home.html": board, "boards/menu.html": board.replace("Menu<", "Carte<") };

  it("frames every board with a file, in manifest order, the same as frameHtml", () => {
    const out = versionFrames("v1", "play", entries, files);
    expect(out.map((b) => b.id)).toEqual(["home", "menu"]);
    expect(out[0]).toEqual({
      id: "home",
      name: "Home",
      width: 1280,
      html: frameHtml(board, "play", new Set(["home", "menu", "lost"])),
    });
  });

  it("returns the cached output for the same version and mode", () => {
    const first = versionFrames("v1", "play", entries, files);
    // Different input under the same key proves the second answer came from the cache.
    const second = versionFrames("v1", "play", entries, { "boards/home.html": "<p>changed</p>" });
    expect(second).toBe(first);
    expect(frameCacheSize()).toBe(1);
  });

  it("keeps versions and modes apart", () => {
    const v1 = versionFrames("v1", "play", entries, files);
    const v2 = versionFrames("v2", "play", entries, { "boards/home.html": "<p>two</p>" });
    const overview = versionFrames("v1", "overview", entries, files);
    expect(v2).not.toBe(v1);
    expect(v2.map((b) => b.id)).toEqual(["home"]);
    expect(v2[0].html).toContain("two");
    expect(v1[0].html).not.toContain("two");
    expect(overview).not.toBe(v1);
    expect(overview[1].html).not.toContain("#board-menu");
    expect(v1[1].html).toContain("#board-menu");
    expect(frameCacheSize()).toBe(3);
  });

  it("evicts the least recently used version past the entry limit", () => {
    const first = versionFrames("v0", "play", entries, files);
    for (let i = 1; i < FRAME_CACHE_MAX_ENTRIES; i++) versionFrames(`v${i}`, "play", entries, files);
    // Touch v0 so v1 is now the oldest.
    expect(versionFrames("v0", "play", entries, files)).toBe(first);
    versionFrames("new", "play", entries, files);
    expect(frameCacheSize()).toBe(FRAME_CACHE_MAX_ENTRIES);
    expect(versionFrames("v0", "play", entries, files)).toBe(first);
    const v1 = versionFrames("v1", "play", entries, {});
    expect(v1).toEqual([]); // re-framed from the new (empty) input: it had been evicted
  });

  it("does not keep a version larger than the byte cap", () => {
    const big = `<!doctype html><html><head><title>x</title></head><body><p>${"x".repeat(17 * 1024 * 1024)}</p></body></html>`;
    versionFrames("huge", "play", entries.slice(0, 1), { "boards/home.html": big });
    expect(frameCacheSize()).toBe(0);
  });
});
