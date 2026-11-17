import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { CANARY_REPORT_WINDOW_MS, canaryCapabilityHash, type NativeCanaryStore } from "./substrate-canary-store.js";

/** A canary actor name no other test uses. */
export const canaryActor = () => `wr-${randomBytes(10).toString("hex")}-canary`;
const TEMPLATE = "wardby-native-0123456789abcdef";
// Obviously fake canary capabilities: only their hashes reach the store.
const HASH = canaryCapabilityHash("fake_canary_capability_0001");
const OTHER_HASH = canaryCapabilityHash("fake_canary_capability_0002");

/**
 * The NativeCanaryStore contract, for the Prisma and memory stores. Every check uses its own rows
 * (random names), so it runs beside other tests on a shared database.
 */
export function canaryStoreContract(make: () => NativeCanaryStore): void {
  it("has no result until one is reported, then keeps the first", async () => {
    const store = make();
    const actor = canaryActor();
    await store.create(actor, TEMPLATE, HASH);
    expect(await store.result(actor)).toBeUndefined();
    const now = new Date();
    expect(await store.report(actor, HASH, "pass", now)).toBe(true);
    expect(await store.result(actor)).toBe("pass");
    expect(await store.report(actor, HASH, "outside_reachable", now)).toBe(false);
    expect(await store.result(actor)).toBe("pass");
    await store.delete(actor);
  });

  it("takes a report from the longest canary, late in its window", async () => {
    const store = make();
    const actor = canaryActor();
    await store.create(actor, TEMPLATE, HASH);
    expect(await store.report(actor, HASH, "pass", new Date(Date.now() + CANARY_REPORT_WINDOW_MS - 30_000))).toBe(true);
    await store.delete(actor);
  });

  it("refuses a report after the report window", async () => {
    const store = make();
    const actor = canaryActor();
    await store.create(actor, TEMPLATE, HASH);
    expect(await store.report(actor, HASH, "pass", new Date(Date.now() + CANARY_REPORT_WINDOW_MS + 60_000))).toBe(
      false,
    );
    expect(await store.result(actor)).toBeUndefined();
    await store.delete(actor);
  });

  it("refuses a report with another capability, and still takes the right one after", async () => {
    const store = make();
    const actor = canaryActor();
    await store.create(actor, TEMPLATE, HASH);
    expect(await store.report(actor, OTHER_HASH, "outside_reachable", new Date())).toBe(false);
    expect(await store.result(actor)).toBeUndefined();
    expect(await store.report(actor, HASH, "pass", new Date())).toBe(true);
    expect(await store.result(actor)).toBe("pass");
    await store.delete(actor);
  });

  it("refuses a canary's capability for another canary's actor", async () => {
    const store = make();
    const [first, second] = [canaryActor(), canaryActor()];
    await store.create(first, TEMPLATE, HASH);
    await store.create(second, TEMPLATE, OTHER_HASH);
    expect(await store.report(second, HASH, "pass", new Date())).toBe(false);
    expect(await store.result(second)).toBeUndefined();
    await store.delete(first);
    await store.delete(second);
  });

  it("refuses a report for an unknown actor", async () => {
    const store = make();
    const actor = canaryActor();
    expect(await store.report(actor, HASH, "pass", new Date())).toBe(false);
    expect(await store.result(actor)).toBeUndefined();
  });

  it("deletes a row, and deleting it again is fine", async () => {
    const store = make();
    const actor = canaryActor();
    await store.create(actor, TEMPLATE, HASH);
    await store.report(actor, HASH, "deny_port_reachable", new Date());
    await store.delete(actor);
    expect(await store.result(actor)).toBeUndefined();
    expect(await store.report(actor, HASH, "pass", new Date())).toBe(false);
    await expect(store.delete(actor)).resolves.toBeUndefined();
  });

  it("lists a row created before a time as stale, whatever its result, and not one created after", async () => {
    const store = make();
    const actor = canaryActor();
    await store.create(actor, TEMPLATE, HASH);
    expect(await store.stale(new Date(Date.now() - 60_000))).not.toContain(actor);
    expect(await store.stale(new Date(Date.now() + 60_000))).toContain(actor);
    await store.report(actor, HASH, "pass", new Date());
    expect(await store.stale(new Date(Date.now() + 60_000))).toContain(actor);
    await store.delete(actor);
    expect(await store.stale(new Date(Date.now() + 60_000))).not.toContain(actor);
  });
}
