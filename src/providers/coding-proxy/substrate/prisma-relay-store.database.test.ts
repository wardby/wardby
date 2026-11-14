import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../../core/db.js";
import { PrismaRelayStore } from "./prisma-relay-store.js";
import { relayStoreContract } from "./relay-store-contract.js";
import { createSubstrateRunFixture } from "./substrate-fixture.test-support.js";

const db = createPrismaClient();
const fixtures: string[] = [];

describe.skipIf(!process.env.DATABASE_URL)("PrismaRelayStore (PostgreSQL)", () => {
  afterAll(async () => {
    for (const runId of fixtures) {
      await db.codingRun.deleteMany({ where: { runId } });
      await db.run.deleteMany({ where: { id: runId } });
    }
    await db.agent.deleteMany({ where: { id: { startsWith: "substrate-agent-" } } });
    await db.$disconnect();
  });

  const fixture = async (token: string) => {
    const { runId } = await createSubstrateRunFixture(db, token);
    fixtures.push(runId);
  };

  relayStoreContract("prisma", async (token, maxBytes) => {
    await fixture(token);
    return new PrismaRelayStore(db, { maxBufferedBytesPerRun: maxBytes, pollIntervalMs: 20 });
  });

  it("serializes concurrent senders across two store instances", { timeout: 30_000 }, async () => {
    const token = `wr-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await fixture(token);
    const a = new PrismaRelayStore(db, { maxBufferedBytesPerRun: 1 << 20 });
    const b = new PrismaRelayStore(db, { maxBufferedBytesPerRun: 1 << 20 });
    const ch = await a.openChannel(token);
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).fromAgent(token, ch, i + 1, `l${i}`)));
    const seqs = (await a.pollTool(token, 0, 0)).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
    // Concurrent sendSeqs arrive out of order, so lower ones may be dropped as duplicates by design.
    expect(seqs.length).toBeGreaterThanOrEqual(2);
  });

  it("purges the run's relay rows and keeps its SubstrateRun row", async () => {
    const token = `wr-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await fixture(token);
    const store = new PrismaRelayStore(db, { maxBufferedBytesPerRun: 1 << 20 });
    const ch = await store.openChannel(token);
    await store.fromAgent(token, ch, 1, "tool request");
    await store.fromTool(token, ch, 1, "tool output");
    await store.purgeRelay(token);
    expect(await db.substrateRelayEvent.count({ where: { runToken: token } })).toBe(0);
    expect(await db.substrateRelayChannel.count({ where: { runToken: token } })).toBe(0);
    expect(await db.substrateRun.findUnique({ where: { token } })).not.toBeNull();
  });

  it("rejects an unknown run", async () => {
    const store = new PrismaRelayStore(db, { maxBufferedBytesPerRun: 1024 });
    await expect(store.openChannel("wr-missing")).rejects.toThrow("relay_unknown");
  });
});
