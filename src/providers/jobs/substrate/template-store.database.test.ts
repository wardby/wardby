import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../../core/db.js";
import { ATESPACE, CUSTOM_TOOL_IMAGE } from "./launcher.test-support.js";
import { describeSubstrateTemplateStoreContract } from "./template-store.contract.test-support.js";
import { PrismaSubstrateTemplateStore } from "./template-store.js";

const db = createPrismaClient();
/** Every row this suite writes is named `wardby-tool-<suite><counter>` (16 hex), deleted after. */
const suite = randomBytes(4).toString("hex");
const prefix = `wardby-tool-${suite}`;
let counter = 0;
const id = () => `${prefix}${(counter++).toString(16).padStart(8, "0")}`;

afterAll(async () => {
  if (!process.env.DATABASE_URL) return;
  await db.substrateTemplate.deleteMany({ where: { name: { startsWith: prefix } } });
  await db.$disconnect();
});

describe.skipIf(!process.env.DATABASE_URL)("PrismaSubstrateTemplateStore (PostgreSQL)", () => {
  describeSubstrateTemplateStoreContract("PrismaSubstrateTemplateStore", {
    store: () => new PrismaSubstrateTemplateStore(db),
    id,
  });

  it("stores only the fixed columns", async () => {
    const columns = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'SubstrateTemplate' ORDER BY column_name`;
    expect(columns.map((c) => c.column_name)).toEqual([
      "atespace",
      "createdAt",
      "goldenFailures",
      "image",
      "lastFailureAt",
      "lastUsedAt",
      "name",
      "readyAt",
      "role",
    ]);
  });

  it("counts concurrent failures once each", async () => {
    const store = new PrismaSubstrateTemplateStore(db);
    const name = id();
    const at = new Date("2026-11-15T12:00:00Z");
    await store.touch({ name, atespace: ATESPACE, role: "tool", image: CUSTOM_TOOL_IMAGE }, at);
    const results = await Promise.all([
      store.recordGoldenFailure(name, at, 600_000),
      store.recordGoldenFailure(name, at, 600_000),
    ]);
    expect([...results].sort()).toEqual([1, 2]);
    expect((await store.get(name))?.goldenFailures).toBe(2);
  });

  it("retries a concurrent first touch as an update", async () => {
    const store = new PrismaSubstrateTemplateStore(db);
    const name = id();
    const ref = { name, atespace: ATESPACE, role: "agent" as const, image: CUSTOM_TOOL_IMAGE };
    const at = new Date("2026-11-15T12:00:00Z");
    await Promise.all([store.touch(ref, at), store.touch(ref, at), store.touch(ref, at)]);
    expect(await store.get(name)).toMatchObject({ name, role: "agent", createdAt: at, lastUsedAt: at });
  });
});
