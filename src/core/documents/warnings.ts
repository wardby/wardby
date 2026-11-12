/** Warnings stored on a version (DocumentVersion.warnings) and returned by create/publish. Our own text only. */
export type VersionWarning =
  | { kind: "kind"; message: string }
  | { kind: "sanitized"; board: string; message: string }
  | { kind: "size"; board: string; message: string }
  | { kind: "fidelity"; board: string; mismatches: number; samples: string[] };

export function warningText(w: VersionWarning): string {
  if (w.kind === "kind") return w.message;
  if (w.kind === "fidelity")
    return `${w.mismatches} style${w.mismatches === 1 ? "" : "s"} may not be editable on board ${w.board}`;
  return `Board ${w.board}: ${w.message}`;
}
