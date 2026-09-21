import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { countUnattendedSchedules, unattendedSchedulesWarning } from "./unattended-schedules.js";

describe("unattendedSchedulesWarning", () => {
  it("is silent at zero and names both remedies otherwise", () => {
    expect(unattendedSchedulesWarning(0)).toBeNull();
    const msg = unattendedSchedulesWarning(2);
    expect(msg).toMatch(/^2 agent\(s\)/);
    expect(msg).toContain('"wardby scheduler"');
    expect(msg).toContain('"wardby serve"');
  });
});

describe.skipIf(!process.env.DATABASE_URL)("countUnattendedSchedules (database)", () => {
  const db = new PrismaClient();
  const names: string[] = [];
  afterAll(async () => {
    await db.agent.deleteMany({ where: { name: { in: names } } });
    await db.$disconnect();
  });

  it("counts only agents whose schedule is enabled and non-null", async () => {
    // Relative assertions: the shared local database may hold other enabled agents.
    const baseline = await countUnattendedSchedules(db);
    const enabled = "unattended-on-" + randomUUID();
    const disabled = "unattended-off-" + randomUUID();
    const unscheduled = "unattended-none-" + randomUUID();
    names.push(enabled, disabled, unscheduled);
    const base = { systemPrompt: "x", model: "gpt-4.1-nano", budgetUsd: 1 };
    await db.agent.create({ data: { ...base, name: enabled, schedule: "*/5 * * * *", scheduleEnabled: true } });
    await db.agent.create({ data: { ...base, name: disabled, schedule: "*/5 * * * *", scheduleEnabled: false } });
    await db.agent.create({ data: { ...base, name: unscheduled, schedule: null, scheduleEnabled: true } });

    expect(await countUnattendedSchedules(db)).toBe(baseline + 1);

    await db.agent.update({ where: { name: enabled }, data: { scheduleEnabled: false } });
    expect(await countUnattendedSchedules(db)).toBe(baseline);
  });
});
