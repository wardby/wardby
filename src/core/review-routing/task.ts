/**
 * The router's task (#646, spec §3.6): fixed text Wardby writes from its own fields. Titles, option labels and
 * the note are stored (redacted) values; no version content is included — the router reads that through doc_get.
 */
export interface RouterTaskInput {
  /** A ReviewEventKind, or "option_chosen". */
  action: string;
  subject: { kind: "document" | "set"; title: string };
  versions: number[];
  /**
   * The documents the router run may read (its grants), by id for doc_get: a set member's (redacted) option
   * label, null outside a set. doc_list does not list them.
   */
  documents: { id: string; label: string | null }[];
  chosen?: { option: string; rejected: string[] };
  byName: string | null;
  note: string | null;
  builderStarted: boolean;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function routerTask(input: RouterTaskInput): string {
  const label = input.action.replace(/_/g, " ");
  const versions =
    input.versions.length === 1 ? `version ${input.versions[0]}` : `versions ${input.versions.join(", ")}`;
  const who = input.byName ? oneLine(input.byName) : "an agent";
  const lines = [`Review action: ${label} on ${oneLine(input.subject.title)} (${versions}).`];
  const named = input.documents.map((d) => (d.label ? `${d.id} (${oneLine(d.label)})` : d.id));
  lines.push(`Documents: ${named.join(", ")}.`);
  if (input.chosen) {
    const rejected = input.chosen.rejected.length ? `; ${input.chosen.rejected.join(", ")} were rejected` : "";
    lines.push(`Option "${input.chosen.option}" was chosen${rejected}.`);
  }
  lines.push(`By: ${who}.`);
  // One line: a multi-line note cannot imitate the task's own lines.
  if (input.note) lines.push(`Note from ${who}: "${oneLine(input.note)}"`);
  if (input.builderStarted) lines.push("The builder for this plan was already started.");
  lines.push(
    "Read the documents and decide who gets the work next, and what the work is. You may start only your attached agents. Do nothing if nothing is needed.",
  );
  return lines.join("\n");
}
