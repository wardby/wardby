import { describe, expect, it } from "vitest";
import { nodesFromHtml, type NodeInit } from "./elements.js";

let n = 0;
const ids = () => `n${++n}`;
/** The tree as `type<tag>.classes[children]` / `leaf:html`, ids left out, for compact assertions. */
function shape(out: ReturnType<typeof nodesFromHtml>): string[] {
  const one = (id: string): string => {
    const x = out.nodes.get(id) as NodeInit;
    if (x.type === "textnode") return `#${JSON.stringify(x.content)}`;
    const head = `${x.type}<${x.tag}>${x.classes ? `.${x.classes.replace(/ /g, ".")}` : ""}`;
    if (x.html !== undefined) return `${head}{${x.html}}`;
    return `${head}[${(x.children ?? []).map(one).join(",")}]`;
  };
  return out.roots.map(one);
}

describe("elements from HTML (GrapesJS 0.23.9 rules)", () => {
  it("a lone text child makes a text box; text with inline tags does too; blocks stay containers", () => {
    const out = nodesFromHtml("<p>Hi</p><div><b>a</b> b</div><div><p>x</p></div>", ids);
    expect(shape(out)).toEqual(["text<p>{Hi}", "text<div>{<b>a</b> b}", "<div>[text<p>{x}]"]);
  });

  it("types by tag: link, image (void), table parts, label, svg with svg-in inside", () => {
    const out = nodesFromHtml(
      '<a href="#x" class="btn">Go</a><img src="a.png"><table><tbody><tr><td>1</td></tr></tbody></table>' +
        '<label>L</label><svg viewBox="0 0 1 1"><path d="M0"></path></svg>',
      ids,
    );
    expect(shape(out)).toEqual([
      "link<a>.btn{Go}",
      "image<img>[]",
      // A cell already has its type, so its lone text stays a text node (only untyped elements become text boxes).
      'table<table>[tbody<tbody>[row<tr>[cell<td>[#"1"]]]]',
      "label<label>{L}",
      "svg<svg>[svg-in<path>[]]",
    ]);
    const img = [...out.nodes.values()].find((x) => x.tag === "img")!;
    expect(img.void).toBe(true);
    expect(img.attrs).toEqual([["src", "a.png"]]);
  });

  it("drops blank text with a newline or at either end, keeps a single space between elements", () => {
    // Spans that are text boxes plus the kept space: the div is a text box itself (all its children are text).
    const out = nodesFromHtml("<div>\n  <span>a</span> <span>b</span>\n</div><section>\n  <h2>t</h2>\n</section>", ids);
    expect(shape(out)).toEqual(["text<div>{<span>a</span> <span>b</span>}", "<section>[text<h2>{t}]"]);
  });

  it("keeps attribute order, makes real booleans true, drops contenteditable, moves class out", () => {
    const out = nodesFromHtml('<input type="checkbox" checked class="a b" contenteditable="true" data-x="1">', ids);
    const input = out.nodes.get(out.roots[0])!;
    expect(input.attrs).toEqual([
      ["type", "checkbox"],
      ["checked", true],
      ["data-x", "1"],
    ]);
    expect(input.classes).toBe("a b");
  });

  it("an inline style becomes a rule on the element's id, as GrapesJS does", () => {
    const out = nodesFromHtml('<div style="color: red; padding: 0">x</div>', ids);
    const id = out.roots[0];
    expect(out.nodes.get(id)!.attrs).toEqual([]);
    expect(out.rules).toEqual([
      {
        id,
        props: [
          ["color", "red"],
          ["padding", "0"],
        ],
      },
    ]);
  });

  it("an element whose own HTML carries an id keeps it as its live id", () => {
    const out = nodesFromHtml('<section id="menu"><h2>Menu</h2></section>', ids);
    expect(out.roots[0]).toBe("menu");
    expect(out.nodes.get("menu")!.ownId).toBe(true);
    expect(out.nodes.get("menu")!.attrs).toEqual([["id", "menu"]]);
  });

  it("a text box's HTML is written the way GrapesJS writes it (void tags close with />, text escaped)", () => {
    const out = nodesFromHtml("<p>14 Hazel Lane<br>Elm &amp; Oak</p>", ids);
    expect(shape(out)).toEqual(["text<p>{14 Hazel Lane<br/>Elm &amp; Oak}"]);
  });
});
