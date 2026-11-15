import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  anchorForElement,
  clamp01,
  elementPath,
  GRAPES_GENERATED_ID,
  locateElement,
  parseElementAnchor,
} from "./element-anchors.js";

const parse = (html: string) => new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document;
const home = () => parse(readFileSync(new URL("./boards/fixtures/coffee/boards/home.html", import.meta.url), "utf8"));

describe("element anchors", () => {
  it("round-trips an element through path and words", () => {
    const doc = home();
    const link = doc.querySelectorAll("nav a")[1];
    const a = anchorForElement("home", link, 0.25, 0.5, doc.body);
    expect(a.path).toMatch(/^header:nth-of-type\(1\)>.*a:nth-of-type\(2\)$/);
    expect(a.words.length).toBeGreaterThan(0);
    expect(locateElement(doc.body, a)).toBe(link);
  });

  it("falls back to unique words when the path moved, and gives up when the element is gone", () => {
    const doc = home();
    const h1 = doc.querySelector("h1")!;
    const a = anchorForElement("home", h1, 0.1, 0.1, doc.body);
    h1.parentElement!.insertBefore(doc.createElement("h1"), h1); // shifts nth-of-type
    expect(locateElement(doc.body, a)).toBe(h1);
    h1.remove();
    expect(locateElement(doc.body, a)).toBeNull();
  });

  it("prefers the element id, and anchors SVG content to its <svg>", () => {
    const doc = parse('<body><p id="lead">Hello there friends</p><div><svg><circle r="3"/></svg></div></body>');
    const a = anchorForElement("home", doc.getElementById("lead")!, 0, 0, doc.body);
    doc.getElementById("lead")!.textContent = "Changed text entirely";
    expect(locateElement(doc.body, a)).toBe(doc.getElementById("lead"));
    const pin = anchorForElement("home", doc.querySelector("circle")!, 0.5, 0.5, doc.body);
    expect(pin.tag).toBe("svg");
  });

  it("rejects malformed anchors", () => {
    const ok = { type: "element", board: "home", path: "body", tag: "body", words: "", dx: 0, dy: 0 };
    expect(parseElementAnchor(ok)).toEqual(ok);
    for (const bad of [
      { ...ok, path: "body>script" },
      { ...ok, dx: 2 },
      { ...ok, board: "Home" },
      { ...ok, extra: 1 },
    ]) {
      expect(() => parseElementAnchor(bad)).toThrow("comment_anchor_invalid");
    }
  });

  it("computes and locates paths relative to an explicit root", () => {
    const doc = parse(
      '<body><nav>skip</nav><div id="wrap"><section><p>First paragraph here</p><p>Second paragraph here</p></section></div></body>',
    );
    const root = doc.getElementById("wrap")!;
    const p = doc.querySelectorAll("p")[1];
    expect(elementPath(p, root)).toBe("section:nth-of-type(1)>p:nth-of-type(2)");
    expect(elementPath(root, root)).toBe("body");
    const a = anchorForElement("home", p, 0.5, 0.5, root);
    expect(locateElement(root, a)).toBe(p);
    expect(locateElement(root, { ...a, path: "section:nth-of-type(1)>p:nth-of-type(1)", words: "" })).toBe(
      doc.querySelectorAll("p")[0],
    );
    const rootAnchor = anchorForElement("home", root, 0, 0, root);
    expect(rootAnchor.path).toBe("body");
    expect(locateElement(root, rootAnchor)).toBe(root);
  });

  it("ignores GrapesJS-generated ids and ids absent from the stored file", () => {
    expect(GRAPES_GENERATED_ID.test("i3kd")).toBe(true);
    expect(GRAPES_GENERATED_ID.test("ix9a-2")).toBe(true);
    expect(GRAPES_GENERATED_ID.test("hero")).toBe(false);
    const doc = parse('<body><p id="i3kd">Generated</p><p id="hero">Named</p><p id="extra">Late</p></body>');
    expect(anchorForElement("home", doc.getElementById("i3kd")!, 0, 0, doc.body).elementId).toBeUndefined();
    expect(anchorForElement("home", doc.getElementById("hero")!, 0, 0, doc.body).elementId).toBe("hero");
    const stored = new Set(["hero"]);
    expect(anchorForElement("home", doc.getElementById("extra")!, 0, 0, doc.body, stored).elementId).toBeUndefined();
    expect(anchorForElement("home", doc.getElementById("hero")!, 0, 0, doc.body, stored).elementId).toBe("hero");
  });

  it("lets storedIds alone decide, so real ids like intro survive", () => {
    const doc = parse('<body><p id="intro">Hi</p><p id="i3kd">Gen</p></body>');
    const stored = new Set(["intro"]);
    expect(anchorForElement("home", doc.getElementById("intro")!, 0, 0, doc.body, stored).elementId).toBe("intro");
    expect(anchorForElement("home", doc.getElementById("i3kd")!, 0, 0, doc.body, stored).elementId).toBeUndefined();
    expect(anchorForElement("home", doc.getElementById("i3kd")!, 0, 0, doc.body, new Set(["i3kd"])).elementId).toBe(
      "i3kd",
    );
    expect(anchorForElement("home", doc.getElementById("i3kd")!, 0, 0, doc.body).elementId).toBeUndefined();
  });

  it("throws when the element is not under the root", () => {
    const doc = parse("<body><div id=a><p>x</p></div><div id=b></div></body>");
    expect(() => elementPath(doc.querySelector("p")!, doc.getElementById("b")!)).toThrow("element_not_under_root");
  });

  it("clamps fractions", () => {
    expect([clamp01(-1), clamp01(2), clamp01(Number.NaN), clamp01(0.3)]).toEqual([0, 1, 0, 0.3]);
  });
});
