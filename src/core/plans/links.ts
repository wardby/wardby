/**
 * Relative links between the documents of a plan set (spec §5b). A plan's Markdown links to other files
 * of the set as written (`api.md`, `./screens/`, `screens/boards/home.html`); the page shows each as a
 * link to that document's page, and the builder gets the same Markdown with each link pointing into the
 * plan folder instead. Only relative links count: a scheme, a leading `/` or an `#`-only link is left
 * alone, and so is one that climbs out of the set's folder.
 */
import { posix } from "node:path";
import { PLAN_FOLDER_PATH } from "../../coding/protocol.js";

/** `[text](href)`: bounded, no nesting, no spaces in the href (titles are not plan links). */
const LINK = /\[([^\]\n]{0,500})\]\(([^)\s]{1,500})\)/g;

export interface PlanSetEntry {
  id: string;
  /** The document's planPath: `api.md`, or `screens/` for a design. */
  path: string;
  kind: "document" | "design";
}

export interface PlanLink {
  href: string;
  documentId: string;
  board?: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** null: not a relative link (left alone); undefined: relative but matches no document; else the target. */
function target(
  href: string,
  fromPath: string,
  set: readonly PlanSetEntry[],
): { documentId: string; board?: string; path: string } | null | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("#")) return null;
  const clean = href.split("#")[0];
  const resolved = posix.normalize(posix.join(posix.dirname(fromPath), clean));
  if (resolved === ".." || resolved.startsWith("../")) return null;
  for (const entry of set) {
    if (entry.kind === "document") {
      if (resolved === entry.path) return { documentId: entry.id, path: entry.path };
      continue;
    }
    const dir = entry.path.replace(/\/$/, "");
    if (resolved === dir || resolved === `${dir}/`) return { documentId: entry.id, path: entry.path };
    const board = new RegExp(`^${escapeRegExp(dir)}/boards/([^/]+)\\.html$`).exec(resolved);
    if (board) return { documentId: entry.id, board: board[1], path: resolved };
  }
  return undefined;
}

/** The relative links of `markdown` (a file at `fromPath` in the set) that name a document of the set, and those that name none. */
export function resolvePlanLinks(
  markdown: string,
  fromPath: string,
  set: readonly PlanSetEntry[],
): { links: PlanLink[]; unresolved: string[] } {
  const links: PlanLink[] = [];
  const unresolved: string[] = [];
  for (const match of markdown.matchAll(LINK)) {
    const href = match[2];
    const found = target(href, fromPath, set);
    if (found === null) continue;
    if (found === undefined) unresolved.push(href);
    else links.push({ href, documentId: found.documentId, ...(found.board ? { board: found.board } : {}) });
  }
  return { links, unresolved };
}

/** The builder's copy: each link to a document of the set points at that file in the plan folder. */
export function rewriteLinksForBuilder(markdown: string, set: readonly PlanSetEntry[], fromPath = "plan.md"): string {
  return markdown.replace(LINK, (whole, text: string, href: string) => {
    const found = target(href, fromPath, set);
    return found ? `[${text}](${PLAN_FOLDER_PATH}/${found.path})` : whole;
  });
}
