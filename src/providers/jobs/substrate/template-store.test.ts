import { describeSubstrateTemplateStoreContract } from "./template-store.contract.test-support.js";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "#prisma";
import { ATESPACE, CUSTOM_TOOL_IMAGE } from "./launcher.test-support.js";
import { MemorySubstrateTemplateStore, PrismaSubstrateTemplateStore } from "./template-store.js";

let counter = 0;
describeSubstrateTemplateStoreContract("MemorySubstrateTemplateStore", {
  store: () => new MemorySubstrateTemplateStore(),
  id: () => `wardby-tool-${(counter++).toString(16).padStart(16, "0")}`,
});

describe("PrismaSubstrateTemplateStore.touch after a concurrent create", () => {
  const ref = {
    name: "wardby-tool-00000000000000aa",
    atespace: ATESPACE,
    role: "tool" as const,
    image: CUSTOM_TOOL_IMAGE,
  };
  const at = new Date("2026-11-15T12:00:00Z");
  const unique = Object.assign(new Error("unique"), { code: "P2002" });

  /** A Prisma client whose upserts answer `upserts` in turn and whose updateMany counts `updated` rows. */
  function stub(upserts: (Error | undefined)[], updated: number) {
    const calls: string[] = [];
    const db = {
      substrateTemplate: {
        upsert: async () => {
          calls.push("upsert");
          const outcome = upserts.shift();
          if (outcome) throw outcome;
          return {};
        },
        updateMany: async () => {
          calls.push("updateMany");
          return { count: updated };
        },
      },
    } as unknown as PrismaClient;
    return { store: new PrismaSubstrateTemplateStore(db), calls };
  }

  it("updates the row the other create made", async () => {
    const { store, calls } = stub([unique], 1);
    await store.touch(ref, at);
    expect(calls).toEqual(["upsert", "updateMany"]);
  });

  it("creates the row again when the cleanup sweep deleted it in between", async () => {
    const { store, calls } = stub([unique, undefined], 0);
    await store.touch(ref, at);
    expect(calls).toEqual(["upsert", "updateMany", "upsert"]);
  });

  it("takes another concurrent create of that row as touched", async () => {
    const { store, calls } = stub([unique, unique], 0);
    await expect(store.touch(ref, at)).resolves.toBeUndefined();
    expect(calls).toEqual(["upsert", "updateMany", "upsert"]);
  });

  it("still fails on any other error", async () => {
    await expect(stub([new Error("down")], 1).store.touch(ref, at)).rejects.toThrow("down");
    await expect(stub([unique, new Error("down")], 0).store.touch(ref, at)).rejects.toThrow("down");
  });
});
