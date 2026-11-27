import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { LIVE_FIELD, liveDocToMarkdown, seedLiveDoc } from "./markdown.js";
import { mergePublish } from "./merge.js";

const V1 = `# Plan

The launch happens in March. We ship the mobile app first.

Pricing stays the same for existing customers. New customers pay the new rate.

## Risks

Support needs training.
`;

const fromState = (s: Uint8Array) => {
  const d = new Y.Doc();
  Y.applyUpdate(d, s);
  return d;
};
/** The n-th top-level paragraph's text (a person typing in it). */
const para = (doc: Y.Doc, n: number) =>
  (
    doc
      .getXmlFragment(LIVE_FIELD)
      .toArray()
      .filter((c) => c instanceof Y.XmlElement && c.nodeName === "paragraph") as Y.XmlElement[]
  )[n].get(0) as Y.XmlText;
const count = (s: string, sub: string) => s.split(sub).length - 1;

describe("mergePublish", () => {
  const base = Y.encodeStateAsUpdate(seedLiveDoc(V1));

  it("brings in the publish and keeps a person's edits made since the base", () => {
    const live = fromState(base);
    const t = para(live, 1);
    live.transact(() => t.insert(t.toString().indexOf("New customers"), "Annual plans keep their price. "));
    const v2 = V1.replace("in March", "in April").replace("## Risks", "## Timeline\n\nBeta first.\n\n## Risks");
    Y.applyUpdate(live, mergePublish(base, v2).update);
    const md = liveDocToMarkdown(live);
    expect(md).toContain("The launch happens in April.");
    expect(md).toContain("## Timeline\n\nBeta first.");
    expect(md).toContain("Annual plans keep their price. New customers");
  });

  it("keeps both sides' changes in the same paragraph", () => {
    const live = fromState(base);
    const t = para(live, 1);
    live.transact(() => t.insert(t.toString().indexOf("New customers"), "Annual plans keep their price. "));
    Y.applyUpdate(live, mergePublish(base, V1.replace("the new rate.", "the new rate from May.")).update);
    expect(liveDocToMarkdown(live)).toContain(
      "Annual plans keep their price. New customers pay the new rate from May.",
    );
  });

  it("applies each change once when merged from the exact base, in order", () => {
    const live = fromState(base);
    const v2 = V1.replace("## Risks", "## Timeline\n\nBeta first.\n\n## Risks");
    const m2 = mergePublish(base, v2);
    Y.applyUpdate(live, m2.update);
    const v3 = v2.replace("Support needs training.", "Support needs two days of training.");
    Y.applyUpdate(live, mergePublish(m2.versionState, v3).update);
    const md = liveDocToMarkdown(live);
    expect(count(md, "## Timeline")).toBe(1);
    expect(md).toContain("two days of training");
  });

  it("versionState is exactly the published version", () => {
    const v2 = V1.replace("March", "April");
    expect(liveDocToMarkdown(fromState(mergePublish(base, v2).versionState))).toBe(liveDocToMarkdown(seedLiveDoc(v2)));
  });

  it("a position inside unchanged words follows the merge; a deleted paragraph's position resolves to nothing", () => {
    const live = fromState(base);
    const t = para(live, 1);
    const at = t.toString().indexOf("existing customers");
    const from = Y.createRelativePositionFromTypeIndex(t, at);
    const to = Y.createRelativePositionFromTypeIndex(t, at + "existing customers".length);
    const quote = (doc: Y.Doc) => {
      const a = Y.createAbsolutePositionFromRelativePosition(from, doc);
      const b = Y.createAbsolutePositionFromRelativePosition(to, doc);
      return a && b && a.type === b.type ? (a.type as Y.XmlText).toString().slice(a.index, b.index) : null;
    };
    Y.applyUpdate(live, mergePublish(base, V1.replace("in March", "in April")).update);
    expect(quote(live)).toBe("existing customers");
    const gone = V1.replace("Pricing stays the same for existing customers. New customers pay the new rate.\n\n", "");
    Y.applyUpdate(live, mergePublish(base, gone).update);
    expect(quote(live)).toBeFalsy();
  });

  describe("touches only the blocks the publish changed", () => {
    const words = ["launch", "pricing", "support", "hiring", "travel", "budget", "office", "design", "tests", "docs"];
    const paras = words.map((w, i) => `The ${w} plan, part ${i}: ${w} notes that read nothing like the others.`);
    const md = (ps: string[]) => ps.join("\n\n") + "\n";
    /** Items the merge deletes from the live copy (the text it re-creates rather than keeps). */
    const deletedBy = (from: string, to: string) => {
      const start = seedLiveDoc(from);
      const state = Y.encodeStateAsUpdate(start);
      const live = fromState(state);
      let deleted = 0;
      live.on("afterTransaction", (tr) => tr.deleteSet.clients.forEach((rs) => rs.forEach((r) => (deleted += r.len))));
      Y.applyUpdate(live, mergePublish(state, to).update);
      expect(liveDocToMarkdown(live)).toBe(liveDocToMarkdown(seedLiveDoc(to)));
      return deleted;
    };
    it("an inserted paragraph deletes nothing", () => {
      expect(deletedBy(md(paras), md([...paras.slice(0, 1), "A new paragraph.", ...paras.slice(1)]))).toBe(0);
    });
    it("a deleted paragraph deletes only that paragraph", () => {
      expect(deletedBy(md(paras), md(paras.filter((_, i) => i !== 1)))).toBe(paras[1].length + 2); // its text, its text node and its element
    });
    it("two edits far apart touch only their own words", () => {
      const edited = paras.map((p, i) => (i === 1 || i === 8 ? p.replace("nothing like", "unlike") : p));
      expect(deletedBy(md(paras), md(edited))).toBeLessThanOrEqual(2 * "nothing like".length);
    });
    it("an inserted list item leaves the other items", () => {
      const list = "- Weekdays from seven\n- Weekends from eight\n- Closed on the first Monday\n";
      expect(
        deletedBy(md(paras.slice(0, 2)) + "\n" + list, md(paras.slice(0, 2)) + "\n- Opening day at six\n" + list),
      ).toBe(0);
    });
    it("a list whose items start with a space (dropped by Markdown) is updated in place, keeping typing in it", () => {
      const list = "- Weekdays from seven\n- Weekends from eight\n- Closed on the first Monday\n- Holidays vary\n";
      const start = seedLiveDoc(md(paras.slice(0, 2)) + "\n" + list);
      const page = fromState(Y.encodeStateAsUpdate(start));
      // People typed at the start of two items far apart (Markdown drops the leading spaces).
      const item = (doc: Y.Doc, i: number) =>
        (((doc.getXmlFragment(LIVE_FIELD).get(2) as Y.XmlElement).get(i) as Y.XmlElement).get(0) as Y.XmlElement).get(
          0,
        ) as Y.XmlText;
      item(page, 1).insert(0, " ");
      item(page, 3).insert(0, " ");
      const state = Y.encodeStateAsUpdate(page);
      const published = liveDocToMarkdown(page).replace("Weekdays", "Weekday mornings");
      // Since that version, someone typed in the list.
      const live = fromState(state);
      item(live, 2).insert(item(live, 2).length, " TYPED-SINCE");
      Y.applyUpdate(live, mergePublish(state, published).update);
      expect(liveDocToMarkdown(live)).toContain("Weekday mornings from seven");
      expect(liveDocToMarkdown(live)).toContain("TYPED-SINCE");
    });

    it("a paragraph changed at both ends keeps the words between (a comment in the middle stays)", () => {
      const start = seedLiveDoc(md(paras));
      const page = fromState(Y.encodeStateAsUpdate(start));
      // A person added a space at both ends of a paragraph (Markdown drops both).
      const t = para(page, 4);
      t.insert(0, " ");
      t.insert(t.length, " ");
      const state = Y.encodeStateAsUpdate(page);
      const live = fromState(state);
      const lt = para(live, 4);
      const at = lt.toString().indexOf("notes");
      const from = Y.createRelativePositionFromTypeIndex(lt, at);
      let deleted = 0;
      live.on("afterTransaction", (tr) => tr.deleteSet.clients.forEach((rs) => rs.forEach((r) => (deleted += r.len))));
      Y.applyUpdate(live, mergePublish(state, liveDocToMarkdown(page).replace("part 9", "part nine")).update);
      expect(deleted).toBeLessThanOrEqual(3); // the two spaces, and "9"
      const abs = Y.createAbsolutePositionFromRelativePosition(from, live);
      expect((abs?.type as Y.XmlText).toString().slice(abs!.index, abs!.index + 5)).toBe("notes");
    });

    it("a paragraph edited next to a new one is paired by its words and updated in place, keeping typing in it", () => {
      const state = Y.encodeStateAsUpdate(seedLiveDoc(md(paras)));
      const live = fromState(state);
      const t = para(live, 3);
      t.insert(t.length, " TYPED-SINCE");
      // The publish edits paragraph 3 and adds one after it: one old block against two new ones.
      const edited = paras.map((p, i) => (i === 3 ? p.replace("part 3", "part three") : p));
      Y.applyUpdate(
        live,
        mergePublish(state, md([...edited.slice(0, 4), "Brand new words.", ...edited.slice(4)])).update,
      );
      expect(liveDocToMarkdown(live)).toContain(
        "part three: hiring notes that read nothing like the others. TYPED-SINCE",
      );
      expect(liveDocToMarkdown(live)).toContain("Brand new words.");
    });

    it("a block Markdown rewrites (bold starting with a space) does not spread to the others", () => {
      const start = seedLiveDoc(md(paras));
      const live = fromState(Y.encodeStateAsUpdate(start));
      // A person bolds text that starts with a space: Markdown writes the space outside the bold.
      const t = para(live, 5);
      t.format(t.toString().indexOf(" notes"), 6, { bold: true });
      const state = Y.encodeStateAsUpdate(live);
      const published = md([...paras.slice(0, 1), "A new paragraph.", ...paras.slice(1)]);
      const target = fromState(state);
      const t2 = para(target, 1);
      const at = Y.createRelativePositionFromTypeIndex(t2, 4);
      Y.applyUpdate(target, mergePublish(state, published.replace(" notes that", " **notes** that")).update);
      expect(Y.createAbsolutePositionFromRelativePosition(at, target)?.type).toBe(para(target, 2));
    });
  });

  it("an unchanged publish produces no content change", () => {
    const live = fromState(base);
    const before = liveDocToMarkdown(live);
    Y.applyUpdate(live, mergePublish(base, V1).update);
    expect(liveDocToMarkdown(live)).toBe(before);
  });
});
