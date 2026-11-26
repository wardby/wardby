/**
 * Markdown documents in the live server: the live document is the editor's Tiptap/Yjs fragment; versions are its
 * Markdown; a publish merges three-way from its base state; comments follow Yjs positions. Documents whose
 * formatting the editor cannot keep (images, checklists, HTML) never go live, and a version like that resets the
 * live document rather than being merged (its content would be dropped).
 */
import * as Y from "yjs";
import { readLiveAnchors } from "../../../core/documents/live/anchors.js";
import { liveDocToMarkdown, normalMarkdown, seedLiveDoc } from "../../../core/documents/live/markdown.js";
import { mergePublish } from "../../../core/documents/live/merge.js";
import { showsSecret } from "../../../core/documents/live/text.js";
import { notifyDocumentChange } from "../../../core/documents/events.js";
import type { WebDeps } from "../../context.js";
import { isLosslessRoundTrip } from "../../app/roundtrip.js";
import type { LiveFormat } from "./types.js";

export function markdownFormat(db: WebDeps["db"]): LiveFormat {
  return {
    async seed(_documentId, v) {
      if (v.format !== "markdown" || v.markdown === null) return null;
      const seed = seedLiveDoc(v.markdown);
      // Formatting the editor cannot keep would be dropped from the live document and then saved: such documents
      // stay out of live editing (the page opens them comment-only, as before).
      return isLosslessRoundTrip(v.markdown, liveDocToMarkdown(seed)) ? seed : null;
    },

    async versionText(_documentId, v) {
      return v.markdown ?? "";
    },

    snapshot(doc, since) {
      const markdown = liveDocToMarkdown(doc);
      if (normalMarkdown(markdown) === normalMarkdown(since)) return null;
      return { content: { markdown }, text: markdown };
    },

    async merge(_documentId, base, v) {
      if (v.format !== "markdown" || v.markdown === null) return "reset";
      const merged = mergePublish(base, v.markdown);
      // A version the editor cannot keep would lose content in the live document: start again without it.
      const check = new Y.Doc();
      Y.applyUpdate(check, merged.versionState);
      if (!isLosslessRoundTrip(v.markdown, liveDocToMarkdown(check))) return "reset";
      return { update: merged.update, versionState: merged.versionState, text: v.markdown };
    },

    refuse(scratch, apply, secretValues) {
      apply();
      return showsSecret(scratch, secretValues) ? "secret_value" : null;
    },

    /** Each thread's stored quote follows its positions; a thread whose words are gone becomes outdated. */
    async refreshAnchors(documentId, doc) {
      const readings = readLiveAnchors(doc);
      if (readings.size === 0) return;
      const threads = await db.commentThread.findMany({
        where: { documentId, id: { in: [...readings.keys()] }, status: { in: ["open", "outdated"] } },
        select: { id: true, status: true, anchor: true },
      });
      let changed = 0;
      for (const th of threads) {
        const r = readings.get(th.id);
        if (!r || r === "keep") continue;
        if (r === "gone") {
          if (th.status === "open") {
            await db.commentThread.update({ where: { id: th.id }, data: { status: "outdated" } });
            changed++;
          }
          continue;
        }
        if (th.status === "open" && JSON.stringify(th.anchor) === JSON.stringify(r)) continue;
        await db.commentThread.update({ where: { id: th.id }, data: { anchor: r, status: "open" } });
        changed++;
      }
      if (changed > 0) await notifyDocumentChange(db, documentId, "thread");
    },
  };
}
