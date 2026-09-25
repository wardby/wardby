import { availableParallelism } from "node:os";
import { describe, expect, it } from "vitest";
import { createPrismaClient, DEFAULT_POOL_TIMEOUT_MS, defaultPoolMax, poolSettings } from "./db.js";

const BASE = "postgresql://user@db.example:5432/wardby";
const defaults = () => ({ max: defaultPoolMax(), connectionTimeoutMillis: DEFAULT_POOL_TIMEOUT_MS });

describe("defaultPoolMax", () => {
  it("is Prisma 6's connection_limit default: parallelism * 2 + 1", () => {
    expect(defaultPoolMax()).toBe(availableParallelism() * 2 + 1);
  });
});

describe("poolSettings", () => {
  it("defaults to Prisma 6's pool size and a 10 s connection timeout", () => {
    expect(DEFAULT_POOL_TIMEOUT_MS).toBe(10_000);
    expect(poolSettings(BASE)).toEqual(defaults());
    expect(poolSettings(`${BASE}?sslmode=require&schema=public`)).toEqual(defaults());
  });

  it("honours connection_limit and pool_timeout (seconds) overrides", () => {
    expect(poolSettings(`${BASE}?connection_limit=5`)).toEqual({
      max: 5,
      connectionTimeoutMillis: DEFAULT_POOL_TIMEOUT_MS,
    });
    expect(poolSettings(`${BASE}?pool_timeout=30`)).toEqual({ max: defaultPoolMax(), connectionTimeoutMillis: 30_000 });
    expect(poolSettings(`${BASE}?connection_limit=3&pool_timeout=2.5`)).toEqual({
      max: 3,
      connectionTimeoutMillis: 2_500,
    });
  });

  it("treats pool_timeout=0 as no timeout, which pg also spells 0", () => {
    expect(poolSettings(`${BASE}?pool_timeout=0`).connectionTimeoutMillis).toBe(0);
  });

  it.each(["0", "-1", "2.5", "abc", "", "Infinity", "1e400"])("ignores connection_limit=%j", (value) => {
    expect(poolSettings(`${BASE}?connection_limit=${value}`).max).toBe(defaultPoolMax());
  });

  it.each(["-1", "abc", "", "Infinity", "1e400"])("ignores pool_timeout=%j", (value) => {
    expect(poolSettings(`${BASE}?pool_timeout=${value}`).connectionTimeoutMillis).toBe(DEFAULT_POOL_TIMEOUT_MS);
  });

  it("falls back to the defaults for a URL it cannot parse", () => {
    expect(poolSettings("not a url?connection_limit=5")).toEqual(defaults());
    expect(poolSettings("")).toEqual(defaults());
  });
});

describe("createPrismaClient", () => {
  it("constructs without a URL but rejects the first query with the DATABASE_URL message", async () => {
    const client = createPrismaClient("");
    await expect(client.$queryRaw`SELECT 1`).rejects.toThrow("DATABASE_URL is not set");
    await client.$disconnect();
  });
});
