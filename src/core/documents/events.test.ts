import { describe, expect, it, vi } from "vitest";
import { DocumentEventSchema, notifyDocumentChange } from "./events.js";

describe("document events", () => {
  it("accept ids and a kind only: any other field (content) is refused", () => {
    expect(DocumentEventSchema.safeParse({ documentId: "doc_1", kind: "comment" }).success).toBe(true);
    expect(DocumentEventSchema.safeParse({ documentId: "doc_1", kind: "comment", body: "hi" }).success).toBe(false);
    expect(DocumentEventSchema.safeParse({ documentId: "doc_1", kind: "title" }).success).toBe(false);
    expect(DocumentEventSchema.safeParse({ documentId: "a b", kind: "thread" }).success).toBe(false);
  });

  it("notifies with the JSON payload and never throws", async () => {
    const calls: unknown[][] = [];
    const ok = { $executeRaw: vi.fn(async (...args: unknown[]) => (calls.push(args), 1)) };
    await notifyDocumentChange(ok as never, "doc_1", "version");
    expect(calls[0].slice(1)).toEqual(["wardby_documents", '{"documentId":"doc_1","kind":"version"}']);
    const failing = { $executeRaw: vi.fn(async () => Promise.reject(new Error("db down"))) };
    await expect(notifyDocumentChange(failing as never, "doc_1", "thread")).resolves.toBeUndefined();
    await expect(notifyDocumentChange(ok as never, "not valid!", "thread")).resolves.toBeUndefined();
    expect(ok.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
