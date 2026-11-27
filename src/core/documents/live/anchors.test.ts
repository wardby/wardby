import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { LIVE_ANCHORS, readLiveAnchors, repointRestoredAnchors } from "./anchors.js";

/** A page and the server, kept in step by updates (the server never sees the page's undo links). */
function pageAndServer() {
  const page = new Y.Doc();
  const server = new Y.Doc();
  page.on("update", (u: Uint8Array) => Y.applyUpdate(server, u));
  const p = new Y.XmlElement("paragraph");
  page.getXmlFragment("default").insert(0, [p]);
  const t = new Y.XmlText();
  p.insert(0, [t]);
  t.insert(0, "Who runs the morning shift in the first week?");
  return { page, server, t };
}
const anchor = (page: Y.Doc, t: Y.XmlText, word: string) => {
  const at = t.toString().indexOf(word);
  page.getMap(LIVE_ANCHORS).set("thread-1", {
    from: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(t, at)),
    to: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(t, at + word.length)),
  });
};
const quoteOn = (doc: Y.Doc) => {
  const r = readLiveAnchors(doc).get("thread-1");
  return typeof r === "object" ? r.quote : r;
};

describe("repointRestoredAnchors", () => {
  it("a comment whose words an undo brought back reads them again on the server", () => {
    const { page, server, t } = pageAndServer();
    anchor(page, t, "morning shift");
    const undo = new Y.UndoManager(t, { captureTimeout: 0 });
    const at = t.toString().indexOf("the morning");
    t.delete(at, "the morning shift ".length);
    expect(quoteOn(server)).toBe("gone");
    undo.undo();
    expect(t.toString()).toContain("morning shift");
    expect(quoteOn(server)).toBe("gone"); // the server cannot tell the restored words are the same ones
    expect(repointRestoredAnchors(page)).toBe(1);
    expect(quoteOn(server)).toBe("morning shift");
  });

  it("leaves positions alone when nothing was restored", () => {
    const { page, server, t } = pageAndServer();
    anchor(page, t, "first week");
    t.insert(0, "New words. ");
    expect(repointRestoredAnchors(page)).toBe(0);
    expect(quoteOn(server)).toBe("first week");
  });

  it("words deleted and not brought back stay gone", () => {
    const { page, server, t } = pageAndServer();
    anchor(page, t, "first week");
    t.delete(t.toString().indexOf("first week"), "first week".length);
    expect(repointRestoredAnchors(page)).toBe(0);
    expect(quoteOn(server)).toBe("gone");
  });
});
