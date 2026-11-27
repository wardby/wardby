/**
 * The router's task (#646, spec §3.6): fixed text Wardby writes from its own fields. Titles, option labels and
 * the note are stored (redacted) values; no version content is included — the router reads that through doc_get.
 */
export interface RouterTaskInput {
  /** A ReviewEventKind, or "option_chosen". */
  action: string;
  subject: { kind: "document" | "set"; title: string };
  versions: number[];
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
  if (input.chosen) {
    const rejected = input.chosen.rejected.length ? `; ${input.chosen.rejected.join(", ")} were rejected` : "";
    lines.push(`Option "${input.chosen.option}" was chosen${rejected}.`);
  }
  lines.push(`By: ${who}.`);
  if (input.note) lines.push(`Note from ${who}: "${input.note}"`);
  if (input.builderStarted) lines.push("The builder for this plan was already started.");
  lines.push(
    "Read the documents and decide who gets the work next, and what the work is. You may start only your attached agents. Do nothing if nothing is needed.",
  );
  return lines.join("\n");
}
