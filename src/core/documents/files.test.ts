import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { storeDocumentContent } from "./files.js";

describe("storeDocumentContent", () => {
  it("inserts new text in hash order, once per hash, whatever the order of the files", async () => {
    const calls: { hash: string }[][] = [];
    const db = {
      documentContent: {
        createMany: async (args: { data: { hash: string }[] }) => {
          calls.push(args.data);
          return { count: args.data.length };
        },
      },
    };
    const files: Record<string, string> = {
      ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`boards/b${i}.html`, `<p>${i}</p>`])),
      "boards/dup.html": "<p>3</p>",
    };
    // Two concurrent publishes would list the same text in different orders; both insert in one order.
    await storeDocumentContent(db as never, "doc", files);
    await storeDocumentContent(db as never, "doc", Object.fromEntries(Object.entries(files).reverse()));
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");
    const expected = [...new Set(Object.values(files).map(sha))].sort();
    expect(calls).toHaveLength(2);
    for (const data of calls) {
      const hashes = data.map((r) => r.hash);
      expect(hashes).toEqual([...hashes].sort());
      expect(new Set(hashes).size).toBe(hashes.length);
    }
    expect(calls[0].map((r) => r.hash)).toEqual(calls[1].map((r) => r.hash));
    expect(calls[0]).toHaveLength(expected.length);
  });
});
