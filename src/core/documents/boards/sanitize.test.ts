import { readFileSync } from "node:fs";
import { JSDOM, type DomDocument } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("sanitizeBoard drops GrapesJS data-gjs-* attributes (T13-1)", () => {
  it("removes data-gjs-* in any case, with markup values, on the body and nested elements", () => {
    const out = sanitizeBoard(
      "<!doctype html><html><head><title>x</title></head>" +
        '<body data-gjs-type="text" DATA-GJS-EDITABLE="true" class="c">' +
        '<div data-gjs-name="<img src=x onerror=1>" data-keep="1"><p DATA-GJS-EDITABLE="true" ' +
        'Data-Gjs-Removable="false">y<span data-gjs-type="link">z</span></p></div></body></html>',
    );
    expect(out.problems).toEqual([]);
    expect(out.html).not.toMatch(/data-gjs-/i);
    expect(out.html).not.toContain("onerror");
    expect(out.html).toContain('data-keep="1"');
    expect(out.html).toContain('<body class="c">');
    const doc = new JSDOM(out.html).window.document;
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      for (const a of Array.from(el.attributes)) expect(a.name.toLowerCase().startsWith("data-gjs-")).toBe(false);
    }
  });

  it("removes data-gjs-* from fragments too", () => {
    const out = sanitizeFragment('<p data-gjs-name="<b>x</b>" DATA-GJS-TYPE="t">y</p>', { images: "drop" });
    expect(JSON.stringify(out)).not.toMatch(/data-gjs-/i);
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

// Fix round 1 regressions: each case reports a problem and carries nothing from https://e.test.
describe("sanitizeBoard CSS bypasses (fix round 1)", () => {
  const board = (head: string, body = "x") =>
    `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
  const refused = (input: string) => {
    const out = sanitizeBoard(input);
    expect(out.problems.length).toBeGreaterThan(0);
    expect(out.html).not.toContain("e.test");
    expect(out.baseCss + (out.editsCss ?? "")).not.toContain("e.test");
    return out;
  };

  it.each([
    ["double", '"'],
    ["single", "'"],
  ])("refuses a %s-quoted string cut by a newline that hides a url()", (_name, q) => {
    refused(board(`<style>a{content:${q}\n} b{background-image:url(https://e.test/x)} c{content:${q}}</style>`));
  });

  it("refuses image-set(var()) and src(var()) in a sheet and in a style attribute", () => {
    refused(board('<style>body{--a:"https://e.test/x.png"} div{background-image:image-set(var(--a) 1x)}</style>'));
    refused(board('<style>body{--a:"https://e.test/x.png"} div{background-image:src(var(--a))}</style>'));
    refused(
      board("", '<div style="--a:&quot;https://e.test/x.png&quot;;background-image:image-set(var(--a) 1x)">y</div>'),
    );
    refused(board("", '<div style="--a:&quot;https://e.test/x.png&quot;;background-image:src(var(--a))">y</div>'));
  });

  it.each([
    ["U+00A0", "\u00a0"],
    ["U+2000", "\u2000"],
    ["U+3000", "\u3000"],
    ["U+FEFF", "\ufeff"],
  ])("refuses a url() whose data: reference starts with %s, in a sheet and in a style attribute", (_name, sp) => {
    const ref = `${sp}data:image/png,/../../web/login?returnTo=/x`;
    for (const input of [
      board(`<style>a{background-image:url("${ref}")}</style>`),
      board("", `<div style="background-image:url(&quot;${ref}&quot;)">y</div>`),
    ]) {
      const out = sanitizeBoard(input);
      expect(out.problems.length).toBeGreaterThan(0);
      expect(out.html + out.baseCss + (out.editsCss ?? "")).not.toContain("/web/login");
    }
  });

  it("checks the style elements as they are joined, not only one by one", () => {
    // A comment opened in one element and closed in the next.
    refused(board('<style>a{}/*</style><style>"*/ b{background-image:url(https://e.test/x)} /*"</style>'));
    // Edits blocks are joined with no separator: "<" + "/style>" would close the element.
    const out = refused(
      board(
        "<style data-wardby-edits>a{color:red}<</style><style data-wardby-edits>/style><img src=https://e.test/x></style>",
      ),
    );
    expect(out.problems).toContain("style text that closes the element in a style sheet");
  });
});

describe("sanitizeBoard writes nothing to the console (fix round 1, secrets)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not print an @import URL or an unparsable sheet that jsdom rejects", () => {
    const spies = (["error", "warn", "log", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const head = (css: string) =>
      `<!doctype html><html><head><title>t</title><style>${css}</style></head><body>x</body></html>`;
    const outs = [
      sanitizeBoard(head('@import "https://[zz/?k=FAKE-SECRET-1";')),
      sanitizeBoard(head('@import "//[x/?k=FAKE-SECRET-3";')),
      sanitizeBoard(head("a{color:red} }}} @media {{{ FAKE-SECRET-2 (((")),
      sanitizeBoard(
        `<!doctype html><html><head><title>t</title></head><body><svg><style>@import "https://[zz/?k=FAKE-SECRET-4";</style></svg></body></html>`,
      ),
    ];
    sanitizeFragment('<div><style>@import "https://[zz/?k=FAKE-SECRET-5";</style></div>', { images: "drop" });
    const written = [...spies, stderr, stdout].flatMap((s) => s.mock.calls);
    stderr.mockRestore();
    stdout.mockRestore();
    expect(written).toEqual([]);
    for (const o of outs) expect(JSON.stringify(o.problems)).not.toContain("FAKE-SECRET");
  });
});
