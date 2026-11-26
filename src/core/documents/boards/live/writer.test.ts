import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BOARD_ROOT, boardMaps, F, R, type BoardMaps } from "./model.js";
import { writeBoard } from "./writer.js";

function el(
  maps: BoardMaps,
  id: string,
  fields: Record<string, unknown>,
  children?: string[],
  attrs?: [string, string | boolean][],
): void {
  const n = new Y.Map<unknown>();
  maps.nodes.set(id, n);
  for (const [k, v] of Object.entries(fields)) n.set(k, v);
  const a = new Y.Map<unknown>();
  const keys = new Y.Array<string>();
  n.set(F.attrs, a);
  n.set(F.attrKeys, keys);
  for (const [k, v] of attrs ?? []) {
    a.set(k, v);
    keys.push([k]);
  }
  if (children) {
    const ch = new Y.Array<string>();
    ch.push(children);
    n.set(F.children, ch);
  }
}

function rule(maps: BoardMaps, key: string, fields: Record<string, unknown>, style: [string, string][]): void {
  const y = new Y.Map<unknown>();
  maps.rules.set(key, y);
  for (const [k, v] of Object.entries(fields)) y.set(k, v);
  const s = new Y.Map<string>();
  const p = new Y.Array<string>();
  y.set(R.style, s);
  y.set(R.props, p);
  for (const [k, v] of style) {
    s.set(k, v);
    p.push([k]);
  }
  maps.ruleOrder.push([key]);
}

const plain = { [R.add]: false, [R.nested]: false, [R.single]: false, [R.important]: "false", [R.singleId]: null };

describe("board writer", () => {
  it("writes attributes in order, then class, and a made-up id only when a styled rule targets it", () => {
    const doc = new Y.Doc();
    const m = boardMaps(doc, "home");
    doc.transact(() => {
      el(m, BOARD_ROOT, { [F.gid]: "wrapper" }, ["i1", "i2", "i3", "c1"]);
      el(
        m,
        "i1",
        { [F.tag]: "a", [F.type]: "link", [F.ownId]: false, [F.classes]: "btn", [F.html]: "Go &amp; see" },
        undefined,
        [
          ["href", "#x"],
          ["title", 'say "hi"'],
        ],
      );
      el(
        m,
        "i2",
        { [F.tag]: "img", [F.type]: "image", [F.void]: true, [F.ownId]: false, [F.classes]: "" },
        [],
        [
          ["src", "a.png"],
          ["hidden", true],
          ["draggable", false],
        ],
      );
      el(m, "i3", { [F.tag]: "section", [F.type]: "", [F.ownId]: true, [F.classes]: "" }, ["t1"], [["id", "menu"]]);
      el(m, "t1", { [F.type]: "textnode", [F.content]: "a < b & c" });
      el(m, "c1", { [F.type]: "comment", [F.content]: " note " });
      rule(
        m,
        "#i2#0",
        { ...plain, [R.sel]: "#i2", [R.selNoAdd]: "#i2", [R.names]: '["#i2"]', [R.atRule]: "", [R.singleId]: "i2" },
        [["width", "10px"]],
      );
      // Selecting an element makes GrapesJS add an empty rule for it: it keeps no id and writes nothing.
      rule(
        m,
        "#i1#0",
        { ...plain, [R.sel]: "#i1", [R.selNoAdd]: "#i1", [R.names]: '["#i1"]', [R.atRule]: "", [R.singleId]: "i1" },
        [],
      );
    });
    const out = writeBoard(m);
    expect(out.body).toBe(
      '<a href="#x" title="say &quot;hi&quot;" class="btn">Go &amp; see</a>' +
        '<img src="a.png" hidden id="i2"/>' +
        '<section id="menu">a &lt; b &amp; c</section>' +
        "<!-- note -->",
    );
    expect(out.css).toBe("#i2{width:10px;}");
    expect(out.spots.map((s) => `${s.kind}:${s.id}`)).toEqual(["leaf:i1", "el:i2", "el:i3", "text:t1"]);
  });

  it("drops rules whose names are unused, groups media queries and sorts them desktop-first", () => {
    const doc = new Y.Doc();
    const m = boardMaps(doc, "home");
    doc.transact(() => {
      el(m, BOARD_ROOT, { [F.gid]: "wrapper" }, ["i1"]);
      el(m, "i1", { [F.tag]: "div", [F.type]: "", [F.ownId]: false, [F.classes]: "card" }, []);
      rule(
        m,
        ".gone#0",
        { ...plain, [R.sel]: ".gone", [R.selNoAdd]: ".gone", [R.names]: '[".gone"]', [R.atRule]: "" },
        [["color", "red"]],
      );
      rule(
        m,
        ".card@@@media (max-width: 480px)#0",
        {
          ...plain,
          [R.sel]: ".card",
          [R.selNoAdd]: ".card",
          [R.names]: '[".card"]',
          [R.atRule]: "@media (max-width: 480px)",
        },
        [["padding", "4px"]],
      );
      rule(
        m,
        ".card#0",
        { ...plain, [R.sel]: ".card", [R.selNoAdd]: ".card", [R.names]: '[".card"]', [R.atRule]: "" },
        [
          ["padding", "24px"],
          ["padding-top", "8px"],
        ],
      );
      rule(
        m,
        ".card@@@media (max-width: 992px)#0",
        {
          ...plain,
          [R.sel]: ".card",
          [R.selNoAdd]: ".card",
          [R.names]: '[".card"]',
          [R.atRule]: "@media (max-width: 992px)",
        },
        [["padding", "12px"]],
      );
    });
    expect(writeBoard(m).css).toBe(
      ".card{padding:24px;padding-top:8px;}" +
        "@media (max-width: 992px){.card{padding:12px;}}" +
        "@media (max-width: 480px){.card{padding:4px;}}",
    );
  });

  it("sorts min-width queries mobile-first, writes !important and single at-rules on their own", () => {
    const doc = new Y.Doc();
    const m = boardMaps(doc, "home");
    doc.transact(() => {
      el(m, BOARD_ROOT, { [F.gid]: "wrapper" }, ["i1"]);
      el(m, "i1", {
        [F.tag]: "p",
        [F.type]: "text",
        [F.ownId]: false,
        [F.classes]: "lead",
        [F.html]: "x",
        [F.names]: '[".em"]',
      });
      rule(
        m,
        "k1",
        {
          ...plain,
          [R.sel]: ".lead",
          [R.selNoAdd]: ".lead",
          [R.names]: '[".lead"]',
          [R.atRule]: "@media (min-width: 900px)",
        },
        [["color", "red"]],
      );
      rule(
        m,
        "k2",
        {
          ...plain,
          [R.sel]: ".em",
          [R.selNoAdd]: ".em",
          [R.names]: '[".em"]',
          [R.atRule]: "@media (min-width: 400px)",
          [R.important]: '["color"]',
        },
        [
          ["color", "blue"],
          ["margin", "0"],
        ],
      );
      rule(
        m,
        "k3",
        { ...plain, [R.sel]: "", [R.selNoAdd]: "", [R.names]: "[]", [R.atRule]: "@font-face", [R.single]: true },
        [["font-family", "Fern"]],
      );
    });
    // GrapesJS's comparator sorts desktop-first unless both queries are min-width, so a query with no number
    // (@font-face) comes ahead of min-width ones; min-width ones among themselves are mobile-first.
    expect(writeBoard(m).css).toBe(
      "@font-face{font-family:Fern;}" +
        "@media (min-width: 400px){.em{color:blue !important;margin:0;}}" +
        "@media (min-width: 900px){.lead{color:red;}}",
    );
  });
});
