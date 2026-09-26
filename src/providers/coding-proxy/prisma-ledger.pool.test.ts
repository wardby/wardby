import { describe, expect, it, vi } from "vitest";
import { LEDGER_TRANSACTION_MAX_WAIT_MS, PrismaProxyLedger, type PrismaProxyLedgerDb } from "./prisma-ledger.js";

describe("PrismaProxyLedger transactions", () => {
  it("wait longer than Prisma's 2 s default for a pool connection", async () => {
    const tx = { $queryRaw: vi.fn(async () => []), $executeRaw: vi.fn(async () => 0) };
    const $transaction = vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
    const ledger = new PrismaProxyLedger({ $transaction } as unknown as PrismaProxyLedgerDb);

    await ledger.reserve({
      id: "req-1",
      sessionId: "missing",
      requestKey: "k",
      requestFingerprint: "fp",
      model: "m",
      reservationUsd: 0.01,
      pricing: { version: "t", encoding: "o200k_base", inputPerMTok: 1, outputPerMTok: 1 },
      now: new Date(),
    });

    expect(LEDGER_TRANSACTION_MAX_WAIT_MS).toBeGreaterThan(2_000);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: LEDGER_TRANSACTION_MAX_WAIT_MS });
  });
});
