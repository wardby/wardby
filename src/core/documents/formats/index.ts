import { boardsFormat } from "./boards.js";
import { markdownFormat } from "./markdown.js";
import type { DocumentFormat } from "./types.js";

export type { Anchor, DocumentFormat, DocumentKind, PreparedContent } from "./types.js";

export function formatFor(kind: string): DocumentFormat {
  if (kind === "document") return markdownFormat;
  if (kind === "design") return boardsFormat;
  throw new Error("document_kind_unsupported");
}
