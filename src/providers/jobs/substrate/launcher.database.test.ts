import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../../core/db.js";
import { createSubstrateRunFixture } from "../../coding-proxy/substrate/substrate-fixture.test-support.js";
import type { SubstrateApi } from "./api.js";
import { makeHarness } from "./launcher.test-support.js";
import { BLOB } from "./names.js";
import { PrismaSubstrateRunStore, type SubstrateRunRecord } from "./run-store.js";

const db = createPrismaClient();
const labels = ["launcher-db-1", "launcher-db-2", "launcher-db-3"];

/**
 * The Prisma store, seeing only this file's parked rows: the launcher sweeps every parked row it can
 * list, and the run-store contract (run-store.database.test.ts) parks and counts its own rows in the
 * same database while this file runs in parallel.
 */
class OwnRowsRunStore extends PrismaSubstrateRunStore {
  private readonly own = new Set(labels.map((label) => `substrate-run-${label}`));

  override async listParked(options: { olderThan?: Date; limit?: number } = {}): Promise<SubstrateRunRecord[]> {
    const rows = (await super.listParked({ olderThan: options.olderThan })).filter((row) => this.own.has(row.runId));
    return options.limit === undefined ? rows : rows.slice(0, options.limit);
  }

  override async countParked(): Promise<number> {
    return (await this.listParked()).length;
  }
}

/** A CodingRun for `label` (the SubstrateRun row's foreign key), with no SubstrateRun yet. */
async function codingRun(label: string): Promise<string> {
  const { runId } = await createSubstrateRunFixture(db, label);
  await db.substrateRun.delete({ where: { runId } });
  return runId;
}

describe.skipIf(!process.env.DATABASE_URL)("SubstrateJobLauncher with PrismaSubstrateRunStore (PostgreSQL)", () => {
  afterAll(async () => {
    for (const label of labels) {
      await db.codingRun.deleteMany({ where: { runId: `substrate-run-${label}` } });
      await db.run.deleteMany({ where: { id: `substrate-run-${label}` } });
      await db.agent.deleteMany({ where: { id: `substrate-agent-${label}` } });
    }
    await db.$disconnect();
  });

  it("launches, fences a repeat or conflicting launch, removes and keeps the tombstone", async () => {
    const runId = await codingRun(labels[0]);
    const h = await makeHarness({ runId, runs: new OwnRowsRunStore(db) });
    const handle = await h.launcher.launch(h.spec);
    expect(h.api.actors.size).toBe(2);
    expect(h.api.egressPolicies.size).toBe(2);
    expect(h.secrets.secrets.size).toBe(1);
    expect((await db.substrateRun.findUnique({ where: { runId } }))?.phase).toBe("running");

    expect(await h.launcher.launch(structuredClone(h.spec))).toEqual(handle);
    expect(h.secrets.calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
    await expect(h.launcher.launch({ ...h.spec, timeoutSec: 601 })).rejects.toThrow("job_spec_conflict");

    await h.blobs.put(BLOB.result(h.token), Buffer.from(JSON.stringify(h.output)));
    await h.blobs.put(BLOB.done(h.token), Buffer.from('{"workspace":"ok"}'));
    expect(await h.launcher.status(handle)).toEqual({ state: "succeeded" });
    await h.launcher.remove(handle);
    expect(h.api.actors.size).toBe(0);
    expect(h.api.egressPolicies.size).toBe(0);
    expect(h.secrets.secrets.size).toBe(0);
    expect(await h.blobs.head(BLOB.done(h.token))).toBeNull();
    expect((await db.substrateRun.findUnique({ where: { runId } }))?.phase).toBe("removed");
    expect(await h.launcher.launch(structuredClone(h.spec))).toEqual(handle);
    expect(h.api.actors.size).toBe(0);
    await expect(h.launcher.status(handle)).rejects.toThrow("job_removed");
  });

  it("records a timeout so it never changes afterwards", async () => {
    const runId = await codingRun(labels[1]);
    const h = await makeHarness({ runId, runs: new OwnRowsRunStore(db) });
    const handle = await h.launcher.launch(h.spec);
    h.setNow(1_000_000 + 600_001);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
    expect((await db.substrateRun.findUnique({ where: { runId } }))?.phase).toBe("timed_out");
    expect(await h.launcher.collect(handle)).toEqual({ exitCode: 124, reason: "timed_out" });
  });

  it("creates the actors exactly once for two concurrent launches", async () => {
    const runId = await codingRun(labels[2]);
    const h = await makeHarness({ runId, runs: new OwnRowsRunStore(db) });
    const created: string[] = [];
    const api: SubstrateApi = h.api;
    const createActor = api.createActor.bind(api);
    h.api.createActor = async (atespace, name, template) => {
      created.push(name);
      return createActor(atespace, name, template);
    };
    const [first, second] = await Promise.all([h.launcher.launch(h.spec), h.launcher.launch(h.spec)]);
    expect(second).toEqual(first);
    expect(created.sort()).toEqual([`${h.token}-agent`, `${h.token}-tool`]);
    expect(h.secrets.calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
  }, 30_000);
});
