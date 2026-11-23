import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../core/db.js";
import { BUILTIN_CODING_SERVICES } from "./builtins.js";
import { CodingServiceDefinitionSchema, catalogEntryFromRow } from "./catalog.js";

const db = createPrismaClient();
const key = (service: { name: string; version: string }) => `${service.name} ${service.version}`;
const byKey = (a: { name: string; version: string }, b: { name: string; version: string }) =>
  key(a).localeCompare(key(b));

describe.skipIf(!process.env.DATABASE_URL)("built-in coding services (PostgreSQL)", () => {
  afterAll(async () => {
    await db.$disconnect();
  });

  it("the migration seeds exactly the built-in catalog wardby ships", async () => {
    const rows = await db.codingService.findMany({ where: { builtin: true } });
    expect(rows.map(catalogEntryFromRow).sort(byKey)).toEqual([...BUILTIN_CODING_SERVICES].sort(byKey));
    expect(rows.every((row) => row.id === `builtin-${row.name}-${row.version}` && row.createdById === null)).toBe(true);
  });

  it("allows one entry per name and version", async () => {
    await expect(
      db.codingService.create({
        data: { ...BUILTIN_CODING_SERVICES[0], id: "duplicate-check", builtin: false },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("stores a setup job's command, waitFor and timeout and reads them back (#589)", async () => {
    const definition = CodingServiceDefinitionSchema.parse({
      name: "db-setup-roundtrip",
      version: "1",
      kind: "setup",
      image: `registry.example/team/migrate@sha256:${"e".repeat(64)}`,
      command: ["migrate", "up"],
      waitFor: ["postgres"],
      resources: { cpuMillicores: 500, memoryMib: 1024, diskMib: 128 },
    });
    try {
      const row = await db.codingService.create({ data: { ...definition, builtin: false } });
      expect(row).toMatchObject({ port: null, readiness: null, dataPath: null, timeoutSeconds: 600 });
      expect(catalogEntryFromRow(row)).toEqual(definition);
    } finally {
      await db.codingService.deleteMany({ where: { name: "db-setup-roundtrip" } });
    }
  });
});
