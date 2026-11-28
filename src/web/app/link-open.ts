/**
 * Opening links in a document. While editing, a click places the cursor (the editor's openOnClick is off), so
 * Cmd/Ctrl-click opens a link, and a small card under a link with the cursor in it shows where it goes, with
 * an Open link. Read-only, a plain click opens it. A Wardby page (a same-origin path such as /d/<id>) opens
 * in this tab; anything else opens in a new tab, without an opener. Only paths, #fragments, http(s) and
 * mailto links open; any other scheme does nothing.
 */
import { Extension, getMarkRange } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { h, placeAt } from "./dom.js";
import type { PlanLinkTargets } from "./extensions.js";

export interface LinkDestination {
  href: string;
  newTab: boolean;
}

/** Where a link's href (as written) opens, or null when it opens nothing. */
export function linkDestination(
  href: string,
  targets: PlanLinkTargets | null,
  origin: string = location.origin,
): LinkDestination | null {
  const to = targets?.get(href) ?? href;
  if (/^\/(?!\/)/.test(to) || to.startsWith("#")) return { href: to, newTab: false };
  if (/^mailto:/i.test(to)) return { href: to, newTab: true };
  if (!/^https?:\/\//i.test(to)) return null;
  try {
    return { href: to, newTab: new URL(to).origin !== origin };
  } catch {
    return null;
  }
}

export function openDestination(d: LinkDestination): void {
  if (d.newTab) window.open(d.href, "_blank", "noopener,noreferrer");
  else location.assign(d.href);
}

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

/** The link mark's href and range at the cursor, when the selection is a cursor inside a link. */
function linkAtCursor(view: EditorView): { href: string; from: number; to: number } | null {
  const { selection, schema } = view.state;
  const type = schema.marks.link;
  if (!type || !selection.empty) return null;
  const range = getMarkRange(selection.$from, type);
  if (!range) return null;
  const mark =
    view.state.doc
      .resolve(range.from + 1)
      .marks()
      .find((m) => m.type === type) ?? null;
  const href = mark && typeof mark.attrs.href === "string" ? mark.attrs.href : "";
  return href ? { href, ...range } : null;
}

export function linkOpening(targets: () => PlanLinkTargets | null) {
  return Extension.create({
    name: "wardbyLinkOpening",
    addProseMirrorPlugins() {
      let card: HTMLDivElement | null = null;
      const hide = () => {
        if (card) card.hidden = true;
      };
      return [
        new Plugin({
          key: new PluginKey("wardby-link-opening"),
          props: {
            handleDOMEvents: {
              click(view, event) {
                const a = (event.target as Element | null)?.closest?.("a[href]");
                if (!a || !view.dom.contains(a)) return false;
                if (view.editable && !(event.metaKey || event.ctrlKey)) return false;
                event.preventDefault();
                // A rendered plan link's href is already its page; any other is the href as written.
                const d = linkDestination(
                  a.getAttribute("href") ?? "",
                  a.classList.contains("plan-link") ? null : targets(),
                );
                if (d) openDestination(d);
                return true;
              },
              blur(_view, event) {
                if (!(card && event.relatedTarget instanceof Node && card.contains(event.relatedTarget))) hide();
                return false;
              },
            },
          },
          view(editorView) {
            card = h("div", { class: "link-card", hidden: true, role: "group", aria: { label: "Link" } });
            // Keep the editor's focus (and the card) while the Open link is pressed.
            card.addEventListener("mousedown", (e) => e.preventDefault());
            document.body.append(card);
            const update = (view: EditorView) => {
              if (!card) return;
              const at = view.editable && view.hasFocus() ? linkAtCursor(view) : null;
              const d = at ? linkDestination(at.href, targets()) : null;
              if (!at || !d) return hide();
              card.replaceChildren(
                h("span", { class: "link-card-href", title: d.href }, d.href),
                h(
                  "a",
                  {
                    class: "link-card-open",
                    attrs: { href: d.href, ...(d.newTab ? { target: "_blank", rel: "noopener noreferrer" } : {}) },
                  },
                  "Open",
                ),
                h("span", { class: "muted" }, `or ${isMac() ? "⌘" : "Ctrl"}-click`),
              );
              card.hidden = false;
              const start = view.coordsAtPos(at.from);
              placeAt(card, Math.max(8, start.left), start.bottom + 6);
            };
            update(editorView);
            return {
              update,
              destroy() {
                card?.remove();
                card = null;
              },
            };
          },
        }),
      ];
    },
  });
}
