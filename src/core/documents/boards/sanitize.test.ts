import { readFileSync } from "node:fs";
import { JSDOM, type DomDocument } from "jsdom";
import { describe, expect, it } from "vitest";
import { sanitizeBoard, sanitizeFragment } from "./sanitize.js";

const fixture = (p: string) => readFileSync(new URL(`./fixtures/${p}`, import.meta.url), "utf8");

/** Structural check (ruling PF-M3): no script element, no on* attribute, no javascript: in any URL attribute. */
function assertScriptFree(html: string): void {
  const doc = new JSDOM(html).window.document;
  expect(doc.querySelectorAll("script")).toHaveLength(0);
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const a of Array.from(el.attributes)) {
      expect(a.name.toLowerCase().startsWith("on"), `${el.localName} ${a.name}`).toBe(false);
      if (/^(?:href|src|xlink:href)$/i.test(a.name))
        expect(a.value.replace(/\s/g, "").replace(/\p{Cc}/gu, "")).not.toMatch(/^javascript:/i);
    }
  }
}

describe("sanitizeBoard", () => {
  it("keeps the coffee boards as written (no removals, no problems) and normalises the head", () => {
    for (const id of ["home", "menu", "about", "visit"]) {
      const out = sanitizeBoard(fixture(`coffee/boards/${id}.html`));
      expect(out.problems, id).toEqual([]);
      expect(out.removed, id).toEqual({ scripts: 0, handlers: 0, jsUrls: 0, other: 0 });
      const doc = new JSDOM(out.html).window.document;
      expect(doc.querySelectorAll("style[data-wardby-base]")).toHaveLength(1);
      expect(doc.querySelector("style[data-wardby-base]")!.textContent).toContain("--terracotta");
      expect(doc.querySelectorAll("a[href^='#board:']").length).toBeGreaterThan(0);
      expect(doc.title).toMatch(/Little Fern Coffee/);
    }
  });

  it("keeps the coffee boards' elements and attributes", () => {
    const input = new JSDOM(fixture("coffee/boards/home.html")).window.document;
    const output = new JSDOM(sanitizeBoard(fixture("coffee/boards/home.html")).html).window.document;
    const shape = (d: DomDocument) =>
      Array.from(d.body.querySelectorAll("*")).map(
        (e) => `${e.localName}[${Array.from(e.attributes, (a) => `${a.name}=${a.value}`).join(" ")}]`,
      );
    expect(shape(output)).toEqual(shape(input));
  });

  it("removes scripts, handlers and javascript: URLs, and drops forbidden elements", () => {
    const out = sanitizeBoard(fixture("hostile.html").replace(/<iframe[^>]*><\/iframe>/, ""));
    expect(out.html).not.toMatch(/<base|http-equiv|<form|<input|<math|<noscript|<animate/i);
    assertScriptFree(out.html);
    expect(out.removed.scripts).toBe(1);
    expect(out.removed.handlers).toBeGreaterThanOrEqual(2);
    expect(out.removed.jsUrls).toBeGreaterThanOrEqual(1);
    expect(out.html).toContain('href="#board:menu"');
    expect(out.html).toContain('href="https://example.com/ok"');
  });

  it("does not keep the text of noscript, template, math or SVG/MathML style elements", () => {
    const out = sanitizeBoard(fixture("hostile.html").replace(/<iframe[^>]*><\/iframe>/, ""));
    expect(out.html).not.toMatch(/onerror|alert/);
    expect(out.baseCss).toBe("body{background-color:#fff}");
    const svgStyle = sanitizeBoard(
      "<!doctype html><html><head><title>x</title></head><body>" +
        "<svg><style>a{color:red}</style></svg><template><p>hidden-template</p></template></body></html>",
    );
    expect(svgStyle.baseCss).toBe("");
    expect(svgStyle.html).not.toContain("color:red");
    expect(svgStyle.html).not.toContain("hidden-template");
    expect(svgStyle.removed.other).toBeGreaterThanOrEqual(2);
  });

  it("refuses the iframe in the hostile fixture as an external reference", () => {
    const out = sanitizeBoard(fixture("hostile.html"));
    expect(out.html).not.toMatch(/<iframe/i);
    expect(out.problems).toEqual(["external reference in iframe src"]);
    expect(out.problems.join(" ")).not.toContain("evil.example");
    assertScriptFree(out.html);
  });

  it("reports external references without echoing the URL", () => {
    const out = sanitizeBoard(
      '<!doctype html><html><head><title>x</title><link rel="stylesheet" href="https://x.test/s.css?k=FAKE-SECRET-123"></head>' +
        '<body><img src="https://x.test/p.png?k=FAKE-SECRET-123"><div style="background:url(https://x.test/q.png)"></div></body></html>',
    );
    expect(out.problems).toEqual(
      expect.arrayContaining([
        "external stylesheet link",
        "external reference in img src",
        "external url() in a style attribute",
      ]),
    );
    expect(out.problems.join(" ")).not.toContain("FAKE-SECRET-123");
  });

  it("refuses relative, protocol-relative and SVG references, and names no caller text", () => {
    const out = sanitizeBoard(
      "<!doctype html><html><head><title>x</title><link rel=icon href=/favicon.ico></head><body>" +
        '<img src="pic-FAKE-SECRET.png"><img src="//x.test/p.png">' +
        '<svg><use href="https://x.test/s.svg#i"/><image href="https://x.test/i.png"/><rect fill="url(https://x.test/p.svg#g)"/></svg>' +
        '<x-FAKE-SECRET src="https://x.test/a"></x-FAKE-SECRET>' +
        "<p style=\"background-image:image-set('https://x.test/a.png' 1x)\">y</p>" +
        "</body></html>",
    );
    expect(out.problems.length).toBeGreaterThanOrEqual(5);
    expect(out.problems.join(" ")).not.toMatch(/FAKE-SECRET|x\.test|favicon/i);
    expect(out.html).not.toContain("x.test");
  });

  it("keeps an existing edits block separate from the base", () => {
    const out = sanitizeBoard(
      "<!doctype html><html><head><title>x</title><style data-wardby-base>a{color:red}</style>" +
        "<style data-wardby-edits>a{color:blue}</style></head><body><a>x</a></body></html>",
    );
    expect(out.baseCss).toBe("a{color:red}");
    expect(out.editsCss).toBe("a{color:blue}");
  });

  it("refuses style text that would close the style element", () => {
    const out = sanitizeBoard(
      "<!doctype html><html><head><title>x</title><style>a{content:'\\3c/style>'}</style></head><body>" +
        "<svg><style>b{}</style></svg></body></html>",
    );
    assertScriptFree(out.html);
    expect(new JSDOM(out.html).window.document.querySelectorAll("style")).toHaveLength(1);
  });

  it("escapes the title and keeps it out of the markup", () => {
    const out = sanitizeBoard(
      "<!doctype html><html><head><title></title><script>x</script></head><body></body></html>",
    );
    expect(out.title).toBe("");
    const t = sanitizeBoard("<!doctype html><title>a &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>");
    assertScriptFree(t.html);
    expect(t.title).toBe("a </title><script>alert(1)</script>");
  });
});

describe("sanitizeFragment", () => {
  const html =
    '<p onclick="x()">Hi <a href="javascript:x()">j</a> <a href="https://example.com/">ok</a></p>' +
    '<img src="https://x.test/p.png"><img src="data:image/png;base64,AAAA"><script>x()</script><style>p{}</style>';

  it("drops external images with a count in drop mode", () => {
    const out = sanitizeFragment(html, { images: "drop" });
    assertScriptFree(out.html);
    expect(out.problems).toEqual([]);
    expect(out.removed).toEqual({ scripts: 1, handlers: 1, jsUrls: 1, other: 1, images: 1 });
    expect(out.html).not.toContain("x.test");
    expect(out.html).toContain("data:image/png;base64,AAAA");
    expect(out.html).toContain('href="https://example.com/"');
  });

  it("reports external images in refuse mode, as boards do", () => {
    const out = sanitizeFragment(html, { images: "refuse" });
    expect(out.problems).toEqual(["external reference in img src"]);
    expect(out.removed.images).toBe(0);
  });
});

describe("sanitizeBoard containers and the body", () => {
  it("does not hoist style elements from noscript or template, and drops a body style with problems", () => {
    const out = sanitizeBoard(
      "<!doctype html><html><head><title>x</title><noscript><style>a{color:red}</style></noscript></head>" +
        '<body style="background:url(https://x.test/b.png)" class="c" onload="x()"><p>y</p></body></html>',
    );
    expect(out.baseCss).toBe("");
    expect(out.problems).toEqual(["external url() in a style attribute"]);
    expect(out.html).toContain('<body class="c">');
    expect(out.removed.handlers).toBe(1);
  });

  it("refuses external SVG paint references but keeps fragment ones and aria text", () => {
    const ok = sanitizeBoard(
      '<!doctype html><title>x</title><svg aria-label="url(https://x.test) is text"><rect fill="url(#g)"/></svg>',
    );
    expect(ok.problems).toEqual([]);
    expect(ok.html).toContain('fill="url(#g)"');
  });
});
