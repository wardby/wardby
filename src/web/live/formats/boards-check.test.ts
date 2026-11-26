/**
 * The per-edit checks on designs (spec "every incoming edit is checked ... against the board format's own rules"):
 * each refusal, and what they cost on the largest fixture board and on a board at the 512 KB limit.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { putNodes, nodesFromHtml } from "../../../core/documents/boards/live/elements.js";
import { BOARD_ROOT, boardMaps, F, R } from "../../../core/documents/boards/live/model.js";
import { checkEdit, watchEdit } from "./boards.js";

const coffee = (p: string) =>
  readFileSync(new URL(`../../../core/documents/boards/fixtures/coffee/${p}`, import.meta.url), "utf8");

/** A built board in a doc, as its builder writes it. */
function built(body: string, baseCss = ""): Y.Doc {
  const doc = new Y.Doc();
  let n = 0;
  const parsed = nodesFromHtml(body, () => `ix${++n}`);
  doc.transact(() => {
    const maps = boardMaps(doc, "home");
    const root = new Y.Map<unknown>();
    maps.nodes.set(BOARD_ROOT, root);
    const ch = new Y.Array<string>();
    ch.push(parsed.roots);
    root.set(F.children, ch);
    putNodes(maps, parsed);
    maps.meta.set("baseCss", baseCss);
  });
  return doc;
}
const bodyOf = (file: string) => {
  const d = new JSDOM(file).window.document;
  for (const st of Array.from(d.querySelectorAll("style"))) st.remove();
  return d.body.innerHTML;
};

/** Checks one edit made by `edit` on a copy of `doc`, as the server does. */
function check(doc: Y.Doc, edit: (d: Y.Doc) => void, secrets: string[] = []): string | null {
  const edited = new Y.Doc();
  Y.applyUpdate(edited, Y.encodeStateAsUpdate(doc));
  const before = Y.encodeStateVector(edited);
  edit(edited);
  const payload = Y.encodeStateAsUpdate(edited, before);
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
  const touched = watchEdit(scratch, () => Y.applyUpdate(scratch, payload));
  return checkEdit(scratch, touched, secrets);
}
const nodeWith = (d: Y.Doc, tag: string) =>
  [...boardMaps(d, "home").nodes.entries()].find(([, n]) => n.get(F.tag) === tag)!;

describe("per-edit checks on designs", () => {
  const doc = built(bodyOf(coffee("boards/home.html")));

  it("lets an ordinary edit through", () => {
    expect(check(doc, (d) => d.transact(() => nodeWith(d, "h1")[1].set(F.html, "Great coffee")))).toBeNull();
  });

  it("refuses scripts, event handlers, javascript: links and external references", () => {
    expect(check(doc, (d) => d.transact(() => nodeWith(d, "h1")[1].set(F.html, "x<script>alert(1)</script>")))).toBe(
      "board_format",
    );
    expect(
      check(doc, (d) =>
        d.transact(() => (nodeWith(d, "h1")[1].get(F.attrs) as Y.Map<unknown>).set("onclick", "steal()")),
      ),
    ).toBe("board_format");
    expect(
      check(doc, (d) =>
        d.transact(() => {
          const a = nodeWith(d, "a")[1];
          (a.get(F.attrs) as Y.Map<unknown>).set("href", "javascript:steal()");
        }),
      ),
    ).toBe("board_format");
    expect(
      check(doc, (d) => d.transact(() => nodeWith(d, "p")[1].set(F.html, '<img src="https://evil.example/x.png">'))),
    ).toBe("board_format");
  });

  it("refuses CSS the format does not allow, in a rule or in the base layer", () => {
    expect(
      check(doc, (d) =>
        d.transact(() => {
          const maps = boardMaps(d, "home");
          const y = new Y.Map<unknown>();
          maps.rules.set("evil", y);
          y.set(R.sel, ".x");
          y.set(R.atRule, "");
          const style = new Y.Map<string>();
          const props = new Y.Array<string>();
          y.set(R.style, style);
          y.set(R.props, props);
          style.set("background", "url(https://evil.example/t.png)");
          props.push(["background"]);
          maps.ruleOrder.push(["evil"]);
        }),
      ),
    ).toBe("board_format");
    expect(check(doc, (d) => boardMaps(d, "home").meta.set("baseCss", '@import "https://evil.example/x.css";'))).toBe(
      "board_format",
    );
  });

  it("refuses an edit that takes the board over 512 KB", () => {
    expect(check(doc, (d) => d.transact(() => nodeWith(d, "p")[1].set(F.html, "x".repeat(520 * 1024))))).toBe(
      "board_too_large",
    );
  });

  it("refuses a secret value in the touched text, attributes or CSS", () => {
    const fake = "sk-fake-1234567890";
    expect(check(doc, (d) => d.transact(() => nodeWith(d, "h1")[1].set(F.html, `key ${fake}`)), [fake])).toBe(
      "secret_value",
    );
    expect(
      check(doc, (d) => d.transact(() => (nodeWith(d, "a")[1].get(F.attrs) as Y.Map<unknown>).set("title", fake)), [
        fake,
      ]),
    ).toBe("secret_value");
  });

  it("costs: a whole fixture board, one edit on it, and one edit on a board at the 512 KB limit", () => {
    const time = (f: () => unknown) => {
      const t = performance.now();
      f();
      return performance.now() - t;
    };
    // The builder's first build touches the whole board.
    const empty = new Y.Doc();
    const full = built(bodyOf(coffee("boards/home.html")));
    const wholeMs = time(() => {
      const scratch = new Y.Doc();
      Y.applyUpdate(scratch, Y.encodeStateAsUpdate(empty));
      const touched = watchEdit(scratch, () => Y.applyUpdate(scratch, Y.encodeStateAsUpdate(full)));
      expect(checkEdit(scratch, touched, [])).toBeNull();
    });
    const oneMs = time(() =>
      expect(check(doc, (d) => d.transact(() => nodeWith(d, "h1")[1].set(F.html, "Hello")))).toBeNull(),
    );
    // A board near the limit: many sections of text.
    const section =
      '<section class="s"><h2>Heading</h2><p>' + "Lorem ipsum dolor sit amet. ".repeat(40) + "</p></section>";
    const big = built(section.repeat(Math.floor((500 * 1024) / section.length)));
    const bigOneMs = time(() =>
      expect(check(big, (d) => d.transact(() => nodeWith(d, "h2")[1].set(F.html, "Changed")))).toBeNull(),
    );
    if (process.env.PERF_OUT) {
      const line = `per-edit checks: whole home board ${wholeMs.toFixed(1)} ms, one edit ${oneMs.toFixed(1)} ms, one edit on a ~500 KB board ${bigOneMs.toFixed(1)} ms\n`;
      writeFileSync(process.env.PERF_OUT, line, { flag: "a" });
    }
    // Generous ceilings: the point is that one edit stays well under a frame's worth of server time per edit.
    expect(oneMs).toBeLessThan(200);
    expect(bigOneMs).toBeLessThan(1000);
  });
});
