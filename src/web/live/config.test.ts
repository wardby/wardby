import { describe, expect, it } from "vitest";
import { loadLiveConfig } from "./config.js";

describe("loadLiveConfig", () => {
  it("is pinned mode without WARDBY_LIVE_REDIS_URL", () => {
    expect(loadLiveConfig({})).toEqual({});
    expect(loadLiveConfig({ WARDBY_LIVE_REDIS_URL: "  " })).toEqual({});
  });

  it("takes a redis:// or rediss:// URL", () => {
    expect(loadLiveConfig({ WARDBY_LIVE_REDIS_URL: "redis://cache:6379" }).redisUrl).toBe("redis://cache:6379");
    expect(loadLiveConfig({ WARDBY_LIVE_REDIS_URL: "rediss://u:p@cache:6380/0" }).redisUrl).toBe(
      "rediss://u:p@cache:6380/0",
    );
  });

  it("refuses anything else without repeating the value (it may hold a password)", () => {
    for (const bad of ["http://cache:6379", "cache:6379", "redis//x"]) {
      let message = "";
      try {
        loadLiveConfig({ WARDBY_LIVE_REDIS_URL: `${bad}?p=s3cret-value` });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("WARDBY_LIVE_REDIS_URL");
      expect(message).not.toContain("s3cret-value");
    }
  });
});
