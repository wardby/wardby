import { describe, expect, it } from "vitest";
import { dueWindow, isDue, validateCronExpression } from "./cron.js";

describe("dueWindow", () => {
  it("is due when never scheduled and a window has already passed", () => {
    const now = new Date("2026-09-05T12:16:00.000Z");
    const window = dueWindow({
      schedule: "*/15 * * * *",
      timezone: "UTC",
      lastScheduledAt: null,
      now,
    });
    expect(window).toEqual(new Date("2026-09-05T12:15:00.000Z"));
  });

  it("is not due again immediately after firing for the current window", () => {
    const now = new Date("2026-09-05T12:16:00.000Z");
    const window = dueWindow({
      schedule: "*/15 * * * *",
      timezone: "UTC",
      lastScheduledAt: new Date("2026-09-05T12:15:00.000Z"),
      now,
    });
    expect(window).toBeNull();
  });

  it("skips missed windows rather than backfilling — returns only the latest", () => {
    // Scheduler was down from 12:00 through 12:44; on recovery at 12:46 it
    // should fire once for 12:45, not for 12:15/12:30 too.
    const now = new Date("2026-09-05T12:46:00.000Z");
    const window = dueWindow({
      schedule: "*/15 * * * *",
      timezone: "UTC",
      lastScheduledAt: new Date("2026-09-05T12:00:00.000Z"),
      now,
    });
    expect(window).toEqual(new Date("2026-09-05T12:45:00.000Z"));
  });

  it("respects timezone across a DST spring-forward boundary", () => {
    // Daily 02:00 America/New_York job. Before the transition, 02:00 EST
    // is 07:00 UTC; after it, 02:00 EDT is 06:00 UTC.
    const beforeTransition = dueWindow({
      schedule: "0 2 * * *",
      timezone: "America/New_York",
      lastScheduledAt: new Date("2026-03-06T00:00:00.000Z"),
      now: new Date("2026-03-08T12:00:00.000Z"),
    });
    expect(beforeTransition).toEqual(new Date("2026-03-08T07:00:00.000Z"));

    const afterTransition = dueWindow({
      schedule: "0 2 * * *",
      timezone: "America/New_York",
      lastScheduledAt: beforeTransition,
      now: new Date("2026-03-09T12:00:00.000Z"),
    });
    expect(afterTransition).toEqual(new Date("2026-03-09T06:00:00.000Z"));
  });
});

describe("isDue", () => {
  it("mirrors dueWindow as a boolean", () => {
    const now = new Date("2026-09-05T12:16:00.000Z");
    expect(
      isDue({ schedule: "*/15 * * * *", timezone: "UTC", lastScheduledAt: null, now }),
    ).toBe(true);
    expect(
      isDue({
        schedule: "*/15 * * * *",
        timezone: "UTC",
        lastScheduledAt: new Date("2026-09-05T12:15:00.000Z"),
        now,
      }),
    ).toBe(false);
  });
});

describe("validateCronExpression", () => {
  it("accepts a well-formed expression", () => {
    expect(() => validateCronExpression("*/15 * * * *", "UTC")).not.toThrow();
  });

  it("throws for a malformed expression", () => {
    expect(() => validateCronExpression("not a cron", "UTC")).toThrow();
  });

  it("throws for an invalid timezone", () => {
    expect(() => validateCronExpression("0 * * * *", "Not/A_Zone")).toThrow();
  });
});
