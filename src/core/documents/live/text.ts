/** The plain text of a live document (for checking it against secret values). */
import * as Y from "yjs";
import { LIVE_FIELD } from "./markdown.js";

export function liveText(doc: Y.Doc): string {
  const out: string[] = [];
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) {
        out.push(
          (child.toDelta() as { insert: unknown }[])
            .map((d) => (typeof d.insert === "string" ? d.insert : ""))
            .join(""),
        );
      } else if (child instanceof Y.XmlElement) {
        // Attribute values (a link's href) are text people can see too.
        for (const v of Object.values(child.getAttributes())) if (typeof v === "string") out.push(v);
        walk(child);
      }
    }
  };
  walk(doc.getXmlFragment(LIVE_FIELD));
  return out.join("\n");
}

/** Whether a live document's text contains any of the secret values. */
export function showsSecret(doc: Y.Doc, secretValues: readonly string[]): boolean {
  if (secretValues.length === 0) return false;
  const text = liveText(doc);
  return secretValues.some((v) => v.length > 0 && text.includes(v));
}
