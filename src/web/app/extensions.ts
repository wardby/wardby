/**
 * The document schema the page edits in: the shared base list
 * (core/documents/editor-schema.ts: StarterKit without Underline, and GFM
 * tables), which the live-editing server uses too. The editor, the
 * round-trip check and the anchoring tests all use this one list.
 *
 * On a plan document the page passes its plan links: a relative link to
 * another document of the set shows as a link to that document's page (a
 * board link opens that board), and a relative link that matches none shows
 * as plain text. Only the rendering changes; the mark keeps its href as
 * written, so the saved Markdown is unchanged.
 */
import { Extension } from "@tiptap/core";
import { DOMSerializer, type Mark } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { editorBaseExtensions } from "../../core/documents/editor-schema.js";
import type { PlanLinksPayload } from "../../core/plans/page-payload.js";

/** Href as written → the page it opens ("/d/<id>", plus "#board-<id>" for a board). */
export type PlanLinkTargets = ReadonlyMap<string, string>;

export function planLinkTargets(links: PlanLinksPayload | undefined): PlanLinkTargets | null {
  if (!links) return null;
  return new Map(
    links.links.map((l) => [
      l.href,
      `/d/${encodeURIComponent(l.documentId)}${l.board ? `#board-${encodeURIComponent(l.board)}` : ""}`,
    ]),
  );
}

/** A relative link (no scheme, no leading `/`, not `#`-only): the only kind a plan link can be. */
const isRelative = (href: string) => !/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[/#]/.test(href);

function planLinks(targets: () => PlanLinkTargets | null) {
  return Extension.create({
    name: "wardbyPlanLinks",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("wardby-plan-links"),
          props: {
            markViews: {
              link: (mark: Mark, _view, inline: boolean) => {
                const href = typeof mark.attrs.href === "string" ? mark.attrs.href : "";
                const map = targets();
                const to = map?.get(href);
                if (to) {
                  const a = document.createElement("a");
                  a.setAttribute("href", to);
                  a.className = "plan-link";
                  return { dom: a };
                }
                if (map && isRelative(href)) {
                  const span = document.createElement("span");
                  span.className = "plan-link-missing";
                  return { dom: span };
                }
                // Any other link renders as the Link mark itself would.
                return DOMSerializer.renderSpec(document, mark.type.spec.toDOM!(mark, inline));
              },
            },
          },
        }),
      ];
    },
  });
}

export function documentExtensions(targets?: () => PlanLinkTargets | null, opts: { collab?: boolean } = {}) {
  return [...editorBaseExtensions(opts), ...(targets ? [planLinks(targets)] : [])];
}
