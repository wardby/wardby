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
