import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import type { NativeCanaryStore } from "./substrate-canary-store.js";

/** A canary actor name no other test uses. */
export const canaryActor = () => `wr-${randomBytes(10).toString("hex")}-canary`;
const TEMPLATE = "wardby-native-0123456789abcdef";

/**
 * The NativeCanaryStore contract, for the Prisma and memory stores. Every check uses its own rows
 * (random names), so it runs beside other tests on a shared database.
 */
export function canaryStoreContract(make: () => NativeCanaryStore): void {
  it("has no result until one is reported, then keeps the first", async () => {
    const store = make();
    const actor = canaryActor();
    await store.create(actor, TEMPLATE);
    expect(await store.result(actor)).toBeUndefined();
    const now = new Date();
    expect(await store.report(actor, "pass", now)).toBe(true);
    expect(await store.result(actor)).toBe("pass");
    expect(await store.report(actor, "outside_reachable", now)).toBe(false);
    expect(await store.result(actor)).toBe("pass");
    await store.delete(actor);
  });

  it("refuses a report more than 10 minutes after the row was created", async () => {
    const store = make();
    const actor = canaryActor();
    await store.create(actor, TEMPLATE);
    expect(await store.report(actor, "pass", new Date(Date.now() + 11 * 60_000))).toBe(false);
    expect(await store.result(actor)).toBeUndefined();
    await store.delete(actor);
  });

  it("refuses a report for an unknown actor", async () => {
    const store = make();
    const actor = canaryActor();
    expect(await store.report(actor, "pass", new Date())).toBe(false);
    expect(await store.result(actor)).toBeUndefined();
  });

  it("deletes a row, and deleting it again is fine", async () => {
    const store = make();
    const actor = canaryActor();
    await store.create(actor, TEMPLATE);
    await store.report(actor, "deny_port_reachable", new Date());
    await store.delete(actor);
    expect(await store.result(actor)).toBeUndefined();
    expect(await store.report(actor, "pass", new Date())).toBe(false);
    await expect(store.delete(actor)).resolves.toBeUndefined();
  });

  it("lists a row created before a time as stale, whatever its result, and not one created after", async () => {
    const store = make();
    const actor = canaryActor();
    await store.create(actor, TEMPLATE);
    expect(await store.stale(new Date(Date.now() - 60_000))).not.toContain(actor);
    expect(await store.stale(new Date(Date.now() + 60_000))).toContain(actor);
    await store.report(actor, "pass", new Date());
    expect(await store.stale(new Date(Date.now() + 60_000))).toContain(actor);
    await store.delete(actor);
    expect(await store.stale(new Date(Date.now() + 60_000))).not.toContain(actor);
  });
}
