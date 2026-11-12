import { describe, expect, it } from "vitest";
import { checkCss } from "./css-check.js";

describe("checkCss", () => {
  it("allows data: images, fragments and plain values", () => {
    expect(checkCss("a{background-image:url(data:image/png;base64,AAAA)} b{filter:url(#f)} c{color:red}")).toEqual([]);
  });
  it("flags external url(), protocol-relative url(), @import, fonts and expression()", () => {
    expect(checkCss("a{background:url(https://x.test/a.png)}")).toEqual(["external_url"]);
    expect(checkCss("a{background:url('//x.test/a.png')}")).toEqual(["external_url"]);
    expect(checkCss("@import 'https://x.test/a.css';")).toEqual(["import"]);
    expect(checkCss("@font-face{font-family:x;src:url(/fonts/x.woff2)}")).toEqual(["external_url"]);
    expect(checkCss("a{width:expression(alert(1))}")).toEqual(["expression"]);
  });
  it("flags text that would close the style element", () => {
    expect(checkCss("a{content:'</style><script>'}")).toEqual(["style_close"]);
  });

  // Controller ruling PF-L14: string references in image-set(), -webkit-image-set() and src().
  it("flags string references in image-set(), -webkit-image-set(), image() and src()", () => {
    expect(checkCss("a{background-image:image-set('https://x.test/a.png' 1x)}")).toEqual(["external_url"]);
    expect(checkCss('a{background-image:-webkit-image-set("//x.test/a.png" 1x)}')).toEqual(["external_url"]);
    expect(checkCss("a{background-image:image('https://x.test/a.png')}")).toEqual(["external_url"]);
    expect(checkCss("@font-face{font-family:x;src:src('https://x.test/x.woff2')}")).toEqual(["external_url"]);
    expect(checkCss("a{background-image:image-set('data:image/png;base64,AAAA' 1x)}")).toEqual([]);
    expect(checkCss("@font-face{font-family:x;src:local('Georgia')}")).toEqual([]);
  });

  // PF-L15: the declarations option the sanitiser uses for style attributes.
  it("checks a style attribute's declarations", () => {
    expect(checkCss("background:url(https://x.test/q.png)", { declarations: true })).toEqual(["external_url"]);
    expect(checkCss("color:red;background-color:var(--x)", { declarations: true })).toEqual([]);
  });

  it("is not fooled by CSS escapes in function, property or at-rule names", () => {
    expect(checkCss("a{background:\\75 rl(https://x.test/a.png)}")).toEqual(["external_url"]);
    expect(checkCss("a{background:U\\52L(https://x.test/a.png)}")).toEqual(["external_url"]);
    expect(checkCss("@\\69mport 'https://x.test/a.css';")).toEqual(["import"]);
    expect(checkCss("a{width:expr\\65ssion(alert(1))}")).toEqual(["expression"]);
  });

  it("still finds references in CSS PostCSS cannot parse (browsers recover from it)", () => {
    expect(checkCss("a{background:url(https://x.test/a.png)")).toEqual(["external_url"]);
    expect(checkCss("a{color:red} } @import 'https://x.test/a.css'; b{")).toEqual(expect.arrayContaining(["import"]));
  });
});

describe("checkCss escape tricks", () => {
  it("finds an escaped url() hidden behind an escaped quote", () => {
    expect(checkCss("a{background:\\22  \\75 rl(https://x.test/a.png)}")).toEqual(["external_url"]);
    expect(checkCss("a{background:\\22  url(https://x.test/a.png)}")).toEqual(["external_url"]);
    expect(checkCss("a{beh\\61vior:url(#x)}")).toEqual(["expression"]);
  });
});

describe("checkCss on large input", () => {
  it("stays fast on long runs of identifiers and escapes", () => {
    const t = Date.now();
    checkCss(`a{content:${"\\a".repeat(100_000)}${"b".repeat(200_000)}}`);
    checkCss(`a{background:${"\\75 ".repeat(50_000)}`);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

// Fix round 1, Critical 1: a string ends at an unescaped newline (CSS Syntax "bad string"), so
// what follows it is CSS again for the browser even where PostCSS reads it as string text.
describe("checkCss strings cut by a newline", () => {
  it.each([
    ["double quotes", 'a{content:"\n} b{background-image:url(https://e.test/x)} c{content:"}'],
    ["single quotes", "a{content:'\n} b{background-image:url(https://e.test/x)} c{content:'}"],
    ["a CRLF newline", 'a{content:"\r\n} b{background-image:url(https://e.test/x)} c{content:"}'],
    ["a form feed", 'a{content:"\f} b{background-image:url(https://e.test/x)} c{content:"}'],
  ])("finds the url() after a string cut by %s", (_name, css) => {
    expect(checkCss(css)).toEqual(expect.arrayContaining(["malformed", "external_url"]));
    expect(checkCss(css, { declarations: true })).toEqual(expect.arrayContaining(["malformed", "external_url"]));
  });
  it("refuses a bad string, an unclosed comment and a broken url() even with nothing after them", () => {
    expect(checkCss('a{content:"x\n"}')).toContain("malformed");
    expect(checkCss("a{color:red}/*")).toContain("malformed");
    expect(checkCss("a{background:url(x y)}")).toEqual(expect.arrayContaining(["malformed", "external_url"]));
  });
  it("keeps an escaped newline inside a string", () => {
    expect(checkCss('a{content:"one\\\ntwo"}')).toEqual([]);
  });
});

// Fix round 1, Critical 2: an image function argument that is not a data: string, a checked
// url() or a gradient could stand for a URL (var() is substituted after any check).
describe("checkCss image function arguments", () => {
  it.each(["image-set", "-webkit-image-set", "image", "src", "cross-fade"])(
    "refuses var(), env() and attr() in %s()",
    (fn) => {
      expect(checkCss(`body{--a:"https://e.test/x.png"} div{background-image:${fn}(var(--a) 1x)}`)).toEqual([
        "external_url",
      ]);
      expect(checkCss(`--a:"https://e.test/x.png";background-image:${fn}(var(--a))`, { declarations: true })).toEqual([
        "external_url",
      ]);
      expect(checkCss(`a{background-image:${fn}(env(--a))}`)).toEqual(["external_url"]);
      expect(checkCss(`a{background-image:${fn}(attr(data-x))}`)).toEqual(["external_url"]);
    },
  );
  it("refuses a nested url() that fails the check, and a bare block", () => {
    expect(checkCss("a{background-image:image-set(url(https://e.test/x) 1x)}")).toEqual(["external_url"]);
    expect(checkCss('a{background-image:image-set(url("https://e.test/x") 1x)}')).toEqual(["external_url"]);
    expect(checkCss("a{background-image:image-set(( 'https://e.test/x' ) 1x)}")).toEqual(["external_url"]);
  });
  it('refuses url("…") with more than one string or with a function inside', () => {
    expect(checkCss('a{background:url("data:image/png,x" "https://e.test")}')).toEqual(["external_url"]);
    expect(checkCss("a{background:url(var(--a))}")).toContain("external_url"); // a bad url token
    expect(checkCss('a{background:url(var(--a) "data:image/png,x")}')).toContain("external_url");
  });
  it("allows data: strings, data: url(), gradients and type() in image functions", () => {
    expect(
      checkCss(
        "a{background-image:image-set('data:image/png;base64,AAAA' 1x, url(data:image/png;base64,AAAA) 2x," +
          ' linear-gradient(var(--a), red) 3x, "data:image/webp;base64,AA" type("image/webp"))}',
      ),
    ).toEqual([]);
    expect(checkCss("a{background:var(--bg, linear-gradient(red, blue))}")).toEqual([]);
  });
});

// A browser's URL parser strips only C0 controls and U+0020, so a Unicode space before "data:"
// makes a relative URL that loads from the page's own origin. JS trim() would hide it.
describe("checkCss Unicode spaces before a reference", () => {
  const spaces: [string, string][] = [
    ["U+00A0", " "],
    ["U+2000", " "],
    ["U+3000", "　"],
    ["U+FEFF", "﻿"],
  ];
  it.each(spaces)("refuses %s before data: and # in a quoted and an unquoted url()", (_name, sp) => {
    for (const ref of [`${sp}data:image/png,/../../web/login?returnTo=/x`, `${sp}#f`]) {
      expect(checkCss(`a{background:url("${ref}")}`)).toContain("external_url");
      expect(checkCss(`a{background:url(${ref})}`)).toContain("external_url");
      expect(checkCss(`a{background-image:image-set("${ref}" 1x)}`)).toContain("external_url");
      expect(checkCss(`background:url("${ref}")`, { declarations: true })).toContain("external_url");
    }
  });
  it("still allows CSS whitespace around a data: or # reference", () => {
    expect(checkCss('a{background:url(" data:image/png,x ")}')).toEqual([]);
    expect(checkCss("a{background:url( data:image/png,x )}")).toEqual([]);
    expect(checkCss('a{background:url("\\9 #f")}')).toEqual([]);
    expect(checkCss('background:url(" #f")', { declarations: true })).toEqual([]);
  });
});
