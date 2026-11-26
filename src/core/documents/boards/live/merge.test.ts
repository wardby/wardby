/**
 * Agent versions merged into a live board (merge.ts), the twelve scenarios proved in the spike, from small fixes to
 * whole-board rewrites. Quiet: with nobody else editing, the merged board is the agent's board. With people: two
 * people's edits made after the version the agent read are all kept, except inside what the agent deleted.
 */
import { JSDOM, type DomDocument, type DomElement, type DomNode } from "jsdom";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildBoard, coffee, coffeeFiles } from "../../../../web/live/design.test-support.js";
import { normalizeDesign } from "../format.js";
import { applyBoardMerge, boardOps, fileParts, merge3, ruleOccurrences } from "./merge.js";
import { boardMaps, F } from "./model.js";
import { writeBoard, writeBoardFile } from "./writer.js";

/** A live-copy field as text. */
const text = (v: unknown): string => (typeof v === "string" ? v : v instanceof Y.Text ? v.toJSON() : "");

type Doc = DomDocument;
type Fact = [string, (body: string, css: string) => boolean];
interface Scenario {
  name: string;
  edit: (d: Doc) => void;
  facts: Fact[];
  loses?: string[];
}
const has =
  (s: string): Fact[1] =>
  (b) =>
    b.includes(s);
const before =
  (a: string, z: string): Fact[1] =>
  (b) =>
    b.indexOf(a) >= 0 && b.indexOf(a) < b.indexOf(z);
const q = (d: Doc, sel: string) => d.querySelector(sel)!;
const baseStyle = (d: Doc) => q(d, "style[data-wardby-base]");

const scenarios: Scenario[] = [
  {
    name: "1 text fix",
    edit: (d) =>
      void (q(d, ".hero p").innerHTML = q(d, ".hero p").innerHTML.replace("small on purpose", "small, on purpose")),
    facts: [["fix is in", has("small, on purpose")]],
  },
  {
    name: "2 add section",
    edit: (d) =>
      q(d, "section.alt").insertAdjacentHTML(
        "afterend",
        '<section class="alt"><div class="wrap"><h2>Opening hours</h2><p>Weekdays 7–6, weekends 8–4.</p></div></section>',
      ),
    facts: [["new section, after the cards", before("Three good reasons", "Opening hours")]],
  },
  {
    name: "3 class + CSS",
    edit: (d) => {
      q(d, ".card:nth-child(2)").classList.add("featured");
      baseStyle(d).textContent =
        baseStyle(d).textContent!.replace("border-radius:16px;padding:24px;", "border-radius:4px;padding:24px;") +
        ".featured{outline:3px solid gold;}";
    },
    facts: [
      ["class added", (b) => /class="card featured"/.test(b)],
      ["rule changed", (_b, c) => /\.card\{[^}]*border-radius:4px/.test(c.replace(/\s+/g, ""))],
      ["new rule", (_b, c) => c.replace(/\s+/g, "").includes(".featured{outline:3pxsolidgold;}")],
    ],
  },
  {
    name: "4 wrap two cards",
    edit: (d) => {
      const cards = d.querySelectorAll(".card");
      const pair = d.createElement("div");
      pair.className = "pair";
      cards[0].before(pair);
      pair.append(cards[0], cards[1]);
    },
    facts: [
      [
        "wrapper holds two cards",
        (b) => /<div class="pair"><div class="card">[\s\S]*?<\/div><div class="card">/.test(b),
      ],
    ],
  },
  {
    name: "5 reformat all + fix",
    edit: (d) => {
      const inline = ["P", "H1", "H2", "H3", "A", "SPAN", "SMALL", "STRONG", "DT", "DD"];
      const pretty = (el: DomElement, depth: number) => {
        for (const c of Array.from(el.children)) {
          if (inline.includes(c.tagName) || c.closest("svg")) continue;
          c.before(d.createTextNode("\n" + "  ".repeat(depth)));
          pretty(c, depth + 1);
        }
      };
      pretty(d.body, 0);
      q(d, "h1").textContent = "Good, honest coffee, a quiet corner, and pastries worth setting an alarm for.";
    },
    facts: [["fix is in", has("Good, honest coffee")]],
  },
  {
    name: "6 rewrite a block",
    edit: (d) =>
      void (q(d, ".hours-box").innerHTML =
        "<h2>Open today</h2><table><tr><th>Mon–Fri</th><td>7–6</td></tr><tr><th>Sat–Sun</th><td>8–4</td></tr></table>"),
    facts: [
      ["table is in", has("<table>")],
      ["old list gone", (b) => !b.includes("<dl>")],
    ],
  },
  {
    name: "7 delete a section",
    edit: (d) => q(d, "section.alt").remove(),
    facts: [["section gone", (b) => !b.includes("Three good reasons")]],
    loses: ["Bo typed in card 3"],
  },
  {
    name: "8 move a section",
    edit: (d) => {
      const secs = d.querySelectorAll("main > section");
      secs[1].before(secs[2]);
    },
    facts: [["moved above the cards", before("This week in the nook", "Three good reasons")]],
  },
  {
    name: "9 rename every class",
    edit: (d) => {
      for (const el of Array.from(d.body.querySelectorAll("[class]")))
        el.setAttribute(
          "class",
          el
            .getAttribute("class")!
            .split(/\s+/)
            .filter(Boolean)
            .map((c) => `fc-${c}`)
            .join(" "),
        );
      const st = baseStyle(d);
      st.textContent = st.textContent!.replace(/\.([a-zA-Z][\w-]*)/g, (m, c: string, i: number, all: string) =>
        /\d$/.test(all.slice(Math.max(0, i - 1), i)) ? m : `.fc-${c}`,
      );
    },
    facts: [
      ["all classes renamed", (b) => !/class="(?![^"]*\bfc-)[^"]+"/.test(b)],
      ["css renamed", (_b, c) => c.includes(".fc-card") && !/\.card[{,:\s]/.test(c)],
    ],
  },
  {
    name: "10 regenerate markup",
    edit: (d) => {
      for (const card of Array.from(d.querySelectorAll(".card"))) {
        const art = d.createElement("article");
        art.className = card.className;
        art.innerHTML = card.innerHTML.replace(/<h3>/g, "<h2>").replace(/<\/h3>/g, "</h2>");
        card.replaceWith(art);
      }
      for (const w of Array.from(d.querySelectorAll(".wrap"))) w.classList.replace("wrap", "container");
    },
    facts: [
      ["cards are articles", (b) => (b.match(/<article class="card"/g) ?? []).length === 3],
      ["no .wrap left", (b) => !/class="[^"]*\bwrap\b/.test(b)],
    ],
  },
  {
    name: "11 copy edit everywhere",
    edit: (d) => {
      for (const el of Array.from(d.querySelectorAll("main p, main h2, main h3"))) {
        const t = el.lastChild;
        if (t && t.nodeType === 3) t.textContent = t.textContent!.replace(/\.?\s*$/, " (revised).");
        else el.append(" (revised).");
      }
    },
    facts: [["every block revised", (b) => (b.match(/\(revised\)\./g) ?? []).length >= 12]],
  },
  {
    name: "12 restructure",
    edit: (d) => {
      q(d, ".header-inner").append(q(d, "footer nav"));
      q(d, ".hero-grid").prepend(q(d, ".cup-art"));
      const cards = Array.from(d.querySelectorAll(".card"));
      const g = q(d, ".grid");
      const row1 = d.createElement("div");
      row1.className = "row";
      const row2 = d.createElement("div");
      row2.className = "row";
      row1.append(cards[0], cards[1]);
      row2.append(cards[2]);
      g.append(row1, row2);
    },
    facts: [
      ["footer nav in header", (b) => /<header[\s\S]*<nav>[\s\S]*<\/header>/.test(b)],
      ["cup first in hero", (b) => b.indexOf("cup-art") < b.indexOf("hero-actions")],
      ["cards in rows", (b) => /<div class="row"><div class="card">/.test(b)],
    ],
  },
];

/** What two people do after the version the agent read: four edits of different kinds, on different elements. */
const people: { name: string; fact: Fact[1]; edit: (doc: Y.Doc) => void }[] = [
  {
    name: "Ann's link title",
    fact: has('title="Menu page"'),
    edit: (doc) => {
      const { nodes } = boardMaps(doc, "home");
      const link = findNode(doc, (n) => n.get(F.tag) === "a" && text(n.get(F.html)).includes("Menu"));
      const n = nodes.get(link)!;
      (n.get(F.attrs) as Y.Map<unknown>).set("title", "Menu page");
      (n.get(F.attrKeys) as Y.Array<string>).push(["title"]);
    },
  },
  {
    name: "Bo's footer class",
    fact: (b) => /<footer class="[^"]*\bdark\b/.test(b),
    edit: (doc) => {
      const n = boardMaps(doc, "home").nodes.get(findNode(doc, (x) => x.get(F.tag) === "footer"))!;
      n.set(F.classes, `${typeof n.get(F.classes) === "string" ? (n.get(F.classes) as string) : ""} dark`.trim());
    },
  },
  {
    name: "Bo typed in card 3",
    fact: has("Bo edit."),
    edit: (doc) => {
      const cards = findAll(doc, (n) => text(n.get(F.classes)).split(" ").includes("card"));
      const ch = boardMaps(doc, "home").nodes.get(cards[2])!.get(F.children) as Y.Array<string>;
      const p = ch.toArray().find((id) => boardMaps(doc, "home").nodes.get(id)?.get(F.tag) === "p")!;
      const n = boardMaps(doc, "home").nodes.get(p)!;
      n.set(F.html, `${String(n.get(F.html))} Bo edit.`);
    },
  },
  {
    name: "Ann's heading colour",
    fact: (_b, c) => c.replace(/\s+/g, "").includes("letter-spacing:2px"),
    // A style set in the editor: a rule in the edits layer.
    edit: (doc) =>
      applyBoardMerge(
        boardMaps(doc, "home"),
        [{ kind: "css-add", selector: "h1", at: "", props: [["letter-spacing", "2px"]] }],
        newId,
      ),
  },
];

function findAll(doc: Y.Doc, test: (n: Y.Map<unknown>) => boolean): string[] {
  // Document order, from the root.
  const { nodes } = boardMaps(doc, "home");
  const out: string[] = [];
  const walk = (id: string) => {
    const n = nodes.get(id);
    if (!n) return;
    if (test(n)) out.push(id);
    for (const c of (n.get(F.children) as Y.Array<string> | undefined)?.toArray() ?? []) walk(c);
  };
  walk("root");
  return out;
}
const findNode = (doc: Y.Doc, test: (n: Y.Map<unknown>) => boolean) => {
  const [id] = findAll(doc, test);
  if (!id) throw new Error("no such element on the coffee board");
  return id;
};

/** Elements inside an `<svg>` whose type is not svg-in (a canvas would create them as HTML and never draw them). */
function untypedInSvg(doc: Y.Doc): string[] {
  const { nodes } = boardMaps(doc, "home");
  const bad: string[] = [];
  const walk = (id: string, inSvg: boolean) => {
    const n = nodes.get(id);
    if (!n) return;
    if (inSvg && n.get(F.type) !== "svg-in" && n.get(F.type) !== "textnode") bad.push(`${text(n.get(F.tag))}#${id}`);
    for (const c of (n.get(F.children) as Y.Array<string> | undefined)?.toArray() ?? [])
      walk(c, inSvg || n.get(F.type) === "svg");
  };
  walk("root", false);
  return bad;
}

/** A body's shape for comparing boards: elements, attributes (made-up ids dropped, classes sorted) and text. */
function shape(html: string): string[] {
  const b = new JSDOM(`<body>${html}</body>`).window.document.body;
  const out: string[] = [];
  const walk = (n: DomNode) => {
    if (n.nodeType === 3) {
      const t = (n.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t) out.push(`"${t}"`);
      return;
    }
    if (n.nodeType !== 1) return;
    const e = n as DomElement;
    const attrs = Array.from(e.attributes)
      .filter((a) => a.name !== "id" || !/^i[a-z0-9]{2,}$/.test(a.value))
      .map((a) => `${a.name}=${a.name === "class" ? a.value.split(/\s+/).sort().join(" ") : a.value}`)
      .sort();
    out.push(`<${e.localName} ${attrs.join(" ")}>`);
    for (const c of Array.from(e.childNodes)) walk(c);
    out.push(`</${e.localName}>`);
  };
  for (const c of Array.from(b.childNodes)) walk(c);
  return out;
}

/** The live board, its stored version (sanitizer form) and the agent's version of it. */
function setup(sc: Scenario) {
  const doc = new Y.Doc();
  buildBoard(doc, "home", coffee("boards/home.html"));
  const stored = normalizeDesign({ ...coffeeFiles(), "boards/home.html": writeBoardFile(boardMaps(doc, "home")) })
    .files["boards/home.html"];
  const dom = new JSDOM(stored);
  sc.edit(dom.window.document);
  const agent = normalizeDesign({ ...coffeeFiles(), "boards/home.html": dom.serialize() }).files["boards/home.html"];
  return { doc, stored, agent };
}

let made = 0;
const newId = () => `i${(++made).toString(36)}x${Math.random().toString(36).slice(2, 6)}`;

describe("merging an agent's board into its live copy", () => {
  for (const sc of scenarios) {
    it(`${sc.name}: with nobody else editing, the result is the agent's board`, () => {
      const { doc, stored, agent } = setup(sc);
      const ops = boardOps(boardMaps(doc, "home"), stored, agent);
      doc.transact(() => applyBoardMerge(boardMaps(doc, "home"), ops, newId));
      const out = writeBoard(boardMaps(doc, "home"));
      const css = `${out.baseCss ?? ""}\n${out.css}`;
      for (const [name, fact] of sc.facts) expect(fact(out.body, css), name).toBe(true);
      expect(untypedInSvg(doc), "elements inside an svg are svg-in").toEqual([]);
      const [x, y] = [shape(out.body), shape(fileParts(agent).bodyHtml)];
      const at = x.findIndex((v, i) => v !== y[i]);
      expect(
        at === -1 && x.length === y.length ? null : { at, merged: x.slice(at, at + 3), agent: y.slice(at, at + 3) },
      ).toBeNull();
    });

    it(`${sc.name}: two people's edits made meanwhile are kept`, () => {
      const { doc, stored, agent } = setup(sc);
      // The agent read the version; then Ann and Bo edit the live copy; then the agent's version arrives.
      const base = Y.encodeStateAsUpdate(doc);
      for (const p of people) doc.transact(() => p.edit(doc));
      const scratch = new Y.Doc();
      Y.applyUpdate(scratch, base);
      const ops = boardOps(boardMaps(scratch, "home"), stored, agent);
      doc.transact(() => applyBoardMerge(boardMaps(doc, "home"), ops, newId));
      const out = writeBoard(boardMaps(doc, "home"));
      const css = `${out.baseCss ?? ""}\n${out.css}`;
      for (const [name, fact] of sc.facts) expect(fact(out.body, css), name).toBe(true);
      for (const p of people) {
        if (sc.loses?.includes(p.name)) continue;
        expect(p.fact(out.body, css), p.name).toBe(true);
      }
    });
  }
});

describe("merge3: two people adding words at the same point", () => {
  it("keeps both (the earlier one first), at the end, at the start and in the middle", () => {
    const base = "Open every day from seven.";
    expect(merge3(base, `${base} ANN`, `${base} BO`)).toBe(`${base} ANN BO`);
    expect(merge3(base, `ANN ${base}`, `BO ${base}`)).toBe(`ANN BO ${base}`);
    expect(merge3(base, "Open every ANN day from seven.", "Open every BO day from seven.")).toBe(
      "Open every ANN BO day from seven.",
    );
    // A box ending in a newline and indentation (as files are written): typing at its end is an insertion.
    const indented = "Open every day from seven.\n      ";
    expect(merge3(indented, `${indented} ANN`, `${indented} BO`)).toBe(`${indented} ANN BO`);
    // Both rewriting the same word is still a conflict: the later one wins.
    expect(merge3(base, "Open every day from six.", "Open every day from eight.")).toBe("Open every day from eight.");
  });
});

describe("merge3 (a text box both sides changed)", () => {
  it("keeps both changes to different words; the new version wins where they overlap", () => {
    const base = "Small batch coffee, roasted on Mondays.";
    expect(
      merge3(base, "Small batch coffee, roasted on Mondays. Bo edit.", "Small-batch coffee, roasted on Mondays."),
    ).toBe("Small-batch coffee, roasted on Mondays. Bo edit.");
    expect(merge3(base, "Small batch tea, roasted on Mondays.", "Small batch cocoa, roasted on Mondays.")).toBe(
      "Small batch cocoa, roasted on Mondays.",
    );
  });
});

describe("rules by their place in the stylesheet", () => {
  it("are found by selector, at-rule and occurrence, whatever their live keys", () => {
    const doc = new Y.Doc();
    buildBoard(doc, "home", coffee("boards/home.html"));
    const maps = boardMaps(doc, "home");
    doc.transact(() =>
      applyBoardMerge(
        maps,
        [
          { kind: "css-add", selector: ".card", at: "", props: [["color", "red"]] },
          { kind: "css-add", selector: ".card", at: "@media (max-width: 600px)", props: [["color", "blue"]] },
          { kind: "css-add", selector: ".card", at: "", props: [["color", "green"]] },
        ],
        newId,
      ),
    );
    const places = ruleOccurrences(maps);
    const style = (place: string) =>
      text((maps.rules.get(places.get(place)!)!.get("style") as Y.Map<string>).get("color"));
    expect(style(".card@@#0")).toBe("red");
    expect(style(".card@@#1")).toBe("green");
    expect(style(".card@@@media(max-width:600px)#0")).toBe("blue");
  });
});

describe("a board built after the version the agent read", () => {
  it("maps the original file (whitespace and all) and keeps a person's edit made since", () => {
    const original = normalizeDesign(coffeeFiles()).files["boards/home.html"];
    const dom = new JSDOM(original);
    const p = dom.window.document.querySelector(".hero p")!;
    p.innerHTML = p.innerHTML.replace("small on purpose", "small, on purpose");
    const agent = normalizeDesign({ ...coffeeFiles(), "boards/home.html": dom.serialize() }).files["boards/home.html"];
    // The board is built from the original file after the agent read it, and Bo edits the heading.
    const doc = new Y.Doc();
    buildBoard(doc, "home", original);
    const maps = boardMaps(doc, "home");
    const h1 = findNode(doc, (n) => n.get(F.tag) === "h1");
    doc.transact(() => maps.nodes.get(h1)!.set(F.html, `${text(maps.nodes.get(h1)!.get(F.html))} BO-SINCE`));
    const ops = boardOps(maps, original, agent, false);
    doc.transact(() => applyBoardMerge(maps, ops, newId));
    const out = writeBoard(maps).body;
    expect(out).toContain("small, on purpose");
    expect(out).toContain("BO-SINCE");
  });

  it("refuses rather than comparing with the live copy's writing when the base file does not line up", () => {
    const doc = new Y.Doc();
    buildBoard(doc, "home", coffee("boards/home.html"));
    const unrelated = "<!doctype html><html><head><title>x</title></head><body><main><p>other</p></main></body></html>";
    expect(() => boardOps(boardMaps(doc, "home"), unrelated, unrelated.replace("other", "changed"), false)).toThrow(
      "version_map_mismatch",
    );
  });
});

describe("new elements inside an svg", () => {
  it("are SVG elements typed svg-in, whether the agent adds one shape or a group", () => {
    const original = normalizeDesign(coffeeFiles()).files["boards/home.html"];
    const doc = new Y.Doc();
    buildBoard(doc, "home", original);
    const stored = normalizeDesign({ ...coffeeFiles(), "boards/home.html": writeBoardFile(boardMaps(doc, "home")) })
      .files["boards/home.html"];
    const dom = new JSDOM(stored);
    const svg = dom.window.document.querySelector(".cup-art svg")!;
    svg.insertAdjacentHTML(
      "beforeend",
      '<circle cx="30" cy="30" r="6" fill="#D9A441"></circle><g><rect width="4" height="4"></rect></g>',
    );
    const agent = normalizeDesign({ ...coffeeFiles(), "boards/home.html": dom.serialize() }).files["boards/home.html"];
    const maps = boardMaps(doc, "home");
    doc.transact(() => applyBoardMerge(maps, boardOps(maps, stored, agent), newId));
    expect(writeBoard(maps).body).toContain('r="6"');
    expect(untypedInSvg(doc)).toEqual([]);
  });
});
