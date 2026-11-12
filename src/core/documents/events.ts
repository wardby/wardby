/**
 * Document change events: after a write commits, the service code sends
 * `pg_notify('wardby_documents', '{"documentId":…,"kind":…}')`; every server
 * replica's documents bus (the shared LISTEN bus) hears it and the web layer
 * forwards it to the browsers streaming that document.
 *
 * Events carry ids and a kind only — never titles, Markdown, comment bodies
 * or names — so no content (and no secret value) can travel this path. A
 * browser that hears one refetches through the access-checked page API.
 *
 * Sent after the write commits, best effort: a failed notify is logged by
 * error name and never fails the write. A lost event is covered by the
 * client's refetch on every reconnect and the bus's resync.
 */
import { z } from "zod";
import type { PrismaClient } from "#prisma";
import { createListenBus, type ListenBus, type ListenBusOptions } from "../listen-bus.js";
import { logger } from "../logger.js";

export const DOCUMENTS_CHANNEL = "wardby_documents";

export const DOCUMENT_EVENT_KINDS = ["thread", "comment", "version", "share"] as const;
export type DocumentEventKind = (typeof DOCUMENT_EVENT_KINDS)[number];

export const DocumentEventSchema = z
  .object({
    documentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    kind: z.enum(DOCUMENT_EVENT_KINDS),
  })
  .strict();
export type DocumentEvent = z.infer<typeof DocumentEventSchema>;

export type DocumentEventBus = ListenBus<DocumentEvent>;

const log = logger.child({ module: "document-events" });

export function createDocumentEventBus(options: ListenBusOptions): DocumentEventBus {
  return createListenBus(
    { channel: DOCUMENTS_CHANNEL, name: "documents event bus", schema: DocumentEventSchema },
    options,
  );
}

/** Tells every replica that a document changed. Never throws. */
export async function notifyDocumentChange(
  db: Pick<PrismaClient, "$executeRaw">,
  documentId: string,
  kind: DocumentEventKind,
): Promise<void> {
  try {
    const payload = JSON.stringify(DocumentEventSchema.parse({ documentId, kind }));
    // $executeRaw, not $queryRaw: pg_notify returns void, which Prisma cannot read as a row.
    await db.$executeRaw`SELECT pg_notify(${DOCUMENTS_CHANNEL}, ${payload})`;
  } catch (err) {
    log.warn({ kind, errorName: err instanceof Error ? err.name : typeof err }, "could not send a document event");
  }
}
