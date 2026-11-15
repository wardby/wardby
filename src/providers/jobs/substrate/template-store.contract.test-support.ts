// One contract for every SubstrateTemplateStore (memory and Prisma): both must behave the same.
import { describe, expect, it } from "vitest";
import { ATESPACE, CUSTOM_TOOL_IMAGE } from "./launcher.test-support.js";
import type { SubstrateTemplateRole, SubstrateTemplateStore } from "./template-store.js";

export interface TemplateStoreContractSetup {
  store: () => SubstrateTemplateStore;
  /** A template-name-shaped name unique to this suite run (the Prisma suite shares a database). */
  id: (name: string) => string;
}

const T0 = Date.parse("2026-11-15T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => new Date(ms);
const FIELDS = [
  "atespace",
  "createdAt",
  "goldenFailures",
  "image",
  "lastFailureAt",
  "lastUsedAt",
  "name",
  "readyAt",
  "role",
];

export function describeSubstrateTemplateStoreContract(name: string, setup: TemplateStoreContractSetup): void {
  describe(`${name}: SubstrateTemplateStore contract`, () => {
    const template = (n: string, role: SubstrateTemplateRole = "tool") => ({
      name: n,
      atespace: ATESPACE,
      role,
      image: CUSTOM_TOOL_IMAGE,
    });

    it("creates on first touch and bumps lastUsedAt after", async () => {
      const store = setup.store();
      const n = setup.id("touch");
      await store.touch(template(n), at(T0));
      const created = await store.get(n);
      expect(created).toEqual({
        name: n,
        atespace: ATESPACE,
        role: "tool",
        image: CUSTOM_TOOL_IMAGE,
        createdAt: at(T0),
        lastUsedAt: at(T0),
        goldenFailures: 0,
      });
      expect(created).not.toHaveProperty("lastFailureAt");
      expect(created).not.toHaveProperty("readyAt");
      await store.touch(template(n), at(T0 + HOUR));
      expect(await store.get(n)).toMatchObject({ createdAt: at(T0), lastUsedAt: at(T0 + HOUR) });
      expect(await store.get(setup.id("absent"))).toBeUndefined();
    });

    it("returns only the fixed fields", async () => {
      const store = setup.store();
      const n = setup.id("fields");
      await store.touch(template(n), at(T0));
      await store.recordGoldenFailure(n, at(T0), 10 * MINUTE);
      await store.recordGoldenFailure(n, at(T0 + MINUTE), 10 * MINUTE);
      await store.markReady([n], at(T0 + 2 * MINUTE));
      const record = (await store.get(n))!;
      for (const key of Object.keys(record)) expect(FIELDS).toContain(key);
      expect(Object.keys(record).sort()).toEqual(FIELDS);
    });

    it("counts failures per window anchored at its first failure", async () => {
      const store = setup.store();
      const n = setup.id("window");
      const window = 10 * MINUTE;
      await store.touch(template(n), at(T0));
      expect(await store.recordGoldenFailure(n, at(T0), window)).toBe(1);
      expect((await store.get(n))?.lastFailureAt).toEqual(at(T0));
      expect(await store.recordGoldenFailure(n, at(T0 + 5 * MINUTE), window)).toBe(2);
      expect(await store.recordGoldenFailure(n, at(T0 + 9 * MINUTE), window)).toBe(3);
      expect(await store.get(n)).toMatchObject({ goldenFailures: 3, lastFailureAt: at(T0) });
      const later = T0 + 10 * MINUTE + 1000;
      expect(await store.recordGoldenFailure(n, at(later), window)).toBe(1);
      expect(await store.get(n)).toMatchObject({ goldenFailures: 1, lastFailureAt: at(later) });
      expect(await store.recordGoldenFailure(setup.id("unknown"), at(T0), window)).toBe(0);
      expect(await store.get(setup.id("unknown"))).toBeUndefined();
    });

    it("a new window clears readyAt", async () => {
      const store = setup.store();
      const n = setup.id("clears");
      await store.touch(template(n), at(T0));
      await store.markReady([n], at(T0));
      expect((await store.get(n))?.readyAt).toEqual(at(T0));
      await store.recordGoldenFailure(n, at(T0 + HOUR), 10 * MINUTE);
      expect(await store.get(n)).not.toHaveProperty("readyAt");
    });

    it("markReady sets only a null readyAt", async () => {
      const store = setup.store();
      const n = setup.id("ready");
      await store.touch(template(n), at(T0));
      await store.markReady([n, setup.id("ready-unknown")], at(T0));
      await store.markReady([n], at(T0 + HOUR));
      expect((await store.get(n))?.readyAt).toEqual(at(T0));
      expect(await store.get(setup.id("ready-unknown"))).toBeUndefined();
      await store.markReady([], at(T0));
    });

    it("touchNames bumps existing rows only", async () => {
      const store = setup.store();
      const a = setup.id("names-a");
      const b = setup.id("names-b");
      await store.touch(template(a, "agent"), at(T0));
      await store.touch(template(b), at(T0));
      const T1 = T0 + HOUR;
      await store.touchNames([a, "wardby-agent-0000000000000000"], at(T1));
      expect((await store.get(a))?.lastUsedAt).toEqual(at(T1));
      expect((await store.get(b))?.lastUsedAt).toEqual(at(T0));
      expect(await store.get("wardby-agent-0000000000000000")).toBeUndefined();
      await store.touchNames([], at(T1));
    });

    const three = async (store: SubstrateTemplateStore, label: string) => {
      const names = [setup.id(`${label}-1`), setup.id(`${label}-2`), setup.id(`${label}-3`)];
      // Touched out of order, so the listing's order is by lastUsedAt, not by insertion.
      await store.touch(template(names[2]), at(T0 + 2 * HOUR));
      await store.touch(template(names[0]), at(T0));
      await store.touch(template(names[1]), at(T0 + HOUR));
      return names;
    };
    const own = (names: string[], listed: { name: string }[]) =>
      listed.map((r) => r.name).filter((n) => names.includes(n));

    it("lists unused rows, least recently used first, within the limit", async () => {
      const store = setup.store();
      const names = await three(store, "list");
      const cutoff = at(T0 + 90 * MINUTE);
      expect(own(names, await store.listUnusedBefore(cutoff, 10_000))).toEqual([names[0], names[1]]);
      const one = await store.listUnusedBefore(cutoff, 1);
      expect(one).toHaveLength(1);
      expect((await store.listUnusedBefore(cutoff, 10_000)).every((r) => r.lastUsedAt < cutoff)).toBe(true);
    });

    it("deletes a row only while it is still unused", async () => {
      const store = setup.store();
      const [first, second] = await three(store, "delete");
      const cutoff = at(T0 + 90 * MINUTE);
      expect(await store.deleteIfUnusedBefore(second, cutoff)).toBe(true);
      expect(await store.get(second)).toBeUndefined();
      expect(await store.deleteIfUnusedBefore(second, cutoff)).toBe(false);
      await store.touch(template(first), at(T0 + 3 * HOUR));
      expect(await store.deleteIfUnusedBefore(first, cutoff)).toBe(false);
      expect(await store.get(first)).toBeDefined();
    });

    it("restore inserts only when absent", async () => {
      const store = setup.store();
      const n = setup.id("restore");
      await store.touch(template(n), at(T0));
      await store.recordGoldenFailure(n, at(T0 + MINUTE), 10 * MINUTE);
      await store.markReady([n], at(T0 + 2 * MINUTE));
      const record = (await store.get(n))!;
      expect(await store.deleteIfUnusedBefore(n, at(T0 + HOUR))).toBe(true);
      await store.restore(record);
      expect(await store.get(n)).toEqual(record);
      const T5 = T0 + 5 * HOUR;
      await store.touch(template(n), at(T5));
      await store.restore(record);
      expect((await store.get(n))?.lastUsedAt).toEqual(at(T5));
    });
  });
}
