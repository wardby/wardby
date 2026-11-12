/**
 * Import fidelity results (spec "Import fidelity check"): the design page renders each board as
 * written and in the editor, compares computed styles per selector, and posts the counts here.
 * They are stored once per version as `fidelity` warnings (warnings.ts).
 *
 * Stated exception to "versions are immutable": DocumentVersion.warnings is derived metadata about
 * the version, not its content. contentHash, files and Markdown never change here, and the write is
 * one conditional statement that only adds fidelity entries to a version that has none yet, so a
 * second report (or two racing ones) changes nothing.
 *
 * Secrets: samples are display text our page code builds from computed styles (selector, property,
 * two values), so they can hold board text. They are capped by the caller and redacted here by exact
 * value against the document agent's secret values before they are stored; the page renders them with
 * textContent.
 */
import type { PrismaClient } from "#prisma";
import type { loadAgentSecretValues } from "../secret-guard.js";
import { redactExactSecretValues } from "../secret-spans.js";
import { parseManifest, MANIFEST_PATH } from "./boards/format.js";
import { loadVersionFiles } from "./files.js";
import { documentSecretValues } from "./redact.js";
import type { VersionWarning } from "./warnings.js";

type Cipher = Parameters<typeof loadAgentSecretValues>[1];

export interface FidelityBoard {
  board: string;
  mismatches: number;
  samples: string[];
}

/**
 * Stores `boards` as fidelity warnings on version `number` of a design, unless that version already
 * has fidelity warnings. Boards not in the version's manifest are ignored. Access is the caller's check.
 */
export async function recordFidelity(
  db: PrismaClient,
  cipher: Cipher,
  input: { documentId: string; number: number; boards: FidelityBoard[] },
): Promise<void> {
  const doc = await db.document.findUnique({
    where: { id: input.documentId },
    select: { kind: true, agentId: true },
  });
  if (!doc) throw new Error("document_not_found");
  if (doc.kind !== "design") throw new Error("document_format_mismatch");
  const version = await db.documentVersion.findUnique({
    where: { documentId_number: { documentId: input.documentId, number: input.number } },
    select: { id: true, format: true },
  });
  if (!version) throw new Error("document_version_not_found");
  if (version.format !== "boards-v1") throw new Error("document_format_mismatch");
  const files = await loadVersionFiles(db, version.id, [MANIFEST_PATH]);
  const listed = new Set(parseManifest(files[MANIFEST_PATH] ?? "").boards.map((b) => b.id));
  const measured = input.boards.filter((b) => listed.has(b.board));
  if (measured.length === 0) return;
  const secrets = await documentSecretValues(db, cipher, doc.agentId);
  const entries: VersionWarning[] = measured.map((b) => ({
    kind: "fidelity",
    board: b.board,
    mismatches: b.mismatches,
    samples: b.samples.map((s) => redactExactSecretValues(s, secrets)),
  }));
  // One conditional statement: appends only while no fidelity entry exists (no read-then-write race).
  await db.$executeRaw`
    UPDATE "DocumentVersion"
    SET "warnings" = (CASE jsonb_typeof("warnings") WHEN 'array' THEN "warnings" ELSE '[]'::jsonb END) || ${JSON.stringify(entries)}::jsonb
    WHERE "id" = ${version.id}
      AND NOT ((CASE jsonb_typeof("warnings") WHEN 'array' THEN "warnings" ELSE '[]'::jsonb END) @> '[{"kind":"fidelity"}]'::jsonb)`;
}
