import { describe, expect, it } from "vitest";
import type { PrismaClient } from "#prisma";
import { PrismaRelayStore } from "./prisma-relay-store.js";
import { RelayBusyError } from "./relay-store.js";

describe("PrismaRelayStore transaction failures", () => {
  it("maps a Prisma transaction timeout (P2028) to RelayBusyError and passes explicit limits", async () => {
    let options: unknown;
    const db = {
      $transaction: async (_fn: unknown, opts: unknown) => {
        options = opts;
        throw Object.assign(new Error("Transaction API error"), { code: "P2028" });
      },
    } as unknown as PrismaClient;
    await expect(new PrismaRelayStore(db).openChannel("wr-00000000000000000001")).rejects.toBeInstanceOf(
      RelayBusyError,
    );
    expect(options).toEqual({ timeout: 5000, maxWait: 2000 });
  });

  it("does not map other errors", async () => {
    const db = {
      $transaction: async () => {
        throw new Error("boom");
      },
    } as unknown as PrismaClient;
    await expect(new PrismaRelayStore(db).openChannel("wr-00000000000000000001")).rejects.toThrow("boom");
  });
});
