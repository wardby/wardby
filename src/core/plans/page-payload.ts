/**
 * The plan bar's payload on the document page API (GET /d/api/<id>) and its warning text. The browser bundle
 * imports this file, so it must import nothing.
 */

export interface PlanSetPayload {
  /**
   * "options" for a native writer's option set (doc_create `set` + `option`): every open member is an
   * alternative, each member's `path` is its option label, and the bar is titled by `name`. Absent for a plan.
   */
  kind?: "plan" | "options";
  /** The option set's name (an option set only; null when it has none). */
  name?: string | null;
  /** The plan's number; 0 for an option set, which the page never shows. */
  number: number;
  /** Counted documents (not removed) that are approved. */
  approved: number;
  /** Documents of the set that count toward approval (not removed). */
  counted: number;
  /** True when the viewer sees only part of the set (a share-link guest): the bar shows no count. */
  partial?: boolean;
  documents: Array<{
    id: string;
    title: string;
    kind: "document" | "design";
    reviewState: string;
    path: string;
    removed: boolean;
    current: boolean;
    /** The current version number (what a choice made from the plan bar approves). */
    versionNumber?: number;
    pagePath: string; // "/d/<id>"; empty for a guest (member routes): the chip has no link
  }>;
}

/** The page's view of a plan document's relative links (src/core/plans/links.ts). */
export interface PlanLinksPayload {
  links: Array<{ href: string; documentId: string; board?: string }>;
  unresolved: string[];
}

/** The page warning for links that match no document of the set. */
export function unresolvedLinksText(planNumber: number, unresolved: readonly string[]): string {
  return `Links to files that are not in plan ${planNumber}: ${unresolved.join(", ")}`;
}
