import { describe, expect, it, vi } from "vitest";
import { scheduleStartFields } from "./schedule-start.js";

describe("scheduleStartFields", () => {
  const weekly = { schedule: "0 6 * * 1", timezone: "UTC", scheduleEnabled: true };

  it("records the database's clock, not this process's, when a schedule starts", async () => {
    const databaseNow = new Date("2026-10-14T15:00:00.000Z");
    const db = { $queryRaw: vi.fn(async () => [{ now: databaseNow }]) };
    expect(await scheduleStartFields(db as never, null, weekly)).toEqual({ lastScheduledAt: databaseNow });
  });

  it("records nothing, and asks the database nothing, when the schedule is unchanged", async () => {
    const db = { $queryRaw: vi.fn() };
    expect(await scheduleStartFields(db as never, weekly, weekly)).toEqual({});
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});
