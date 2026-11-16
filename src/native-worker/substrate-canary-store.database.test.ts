import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { PrismaNativeCanaryStore } from "./substrate-canary-store.js";
import { canaryStoreContract } from "./substrate-canary-store.test-support.js";

describe.skipIf(!process.env.DATABASE_URL)("PrismaNativeCanaryStore (database)", () => {
  const db = createPrismaClient();
  afterAll(async () => {
    await db.$disconnect();
  });

  canaryStoreContract(() => new PrismaNativeCanaryStore(db));

  it("holds no credential and no run data: exactly these columns", async () => {
    const columns = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'NativeSubstrateCanary'
      ORDER BY column_name`;
    expect(columns.map((c) => c.column_name)).toEqual(["actor", "createdAt", "reportedAt", "result", "template"]);
  });
});
