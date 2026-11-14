import { describe, expect, it } from "vitest";
import { RelayBackpressureError, type RelayStore } from "./relay-store.js";

/** `create` returns a store whose run `token` exists and allows `maxBytes` of buffered lines. */
export function relayStoreContract(
  name: string,
  create: (token: string, maxBytes: number) => Promise<RelayStore>,
): void {
  describe(`${name} RelayStore`, () => {
    it("relays an open channel and lines both ways", async () => {
      const store = await create("wr-00000000000000000001", 1 << 20);
      const ch = await store.openChannel("wr-00000000000000000001");
      await store.fromAgent("wr-00000000000000000001", ch, 1, '{"a":1}');
      expect(await store.pollTool("wr-00000000000000000001", 0, 10)).toEqual([
        { seq: 1, type: "open", channel: ch },
        { seq: 2, type: "line", channel: ch, line: '{"a":1}' },
      ]);
      await store.fromTool("wr-00000000000000000001", ch, 1, '{"b":2}');
      expect(await store.pollAgent("wr-00000000000000000001", ch, 0, 10)).toEqual([
        { seq: 1, type: "line", line: '{"b":2}' },
      ]);
    });

    it("ignores a repeated sendSeq", async () => {
      const store = await create("wr-00000000000000000002", 1 << 20);
      const ch = await store.openChannel("wr-00000000000000000002");
      await store.fromAgent("wr-00000000000000000002", ch, 1, "x");
      await store.fromAgent("wr-00000000000000000002", ch, 1, "x");
      expect((await store.pollTool("wr-00000000000000000002", 0, 10)).filter((e) => e.type === "line")).toHaveLength(1);
    });

    it("redelivers until the cursor advances, then deletes", async () => {
      const store = await create("wr-00000000000000000003", 1 << 20);
      const ch = await store.openChannel("wr-00000000000000000003");
      await store.fromAgent("wr-00000000000000000003", ch, 1, "x");
      expect(await store.pollTool("wr-00000000000000000003", 0, 10)).toHaveLength(2);
      expect(await store.pollTool("wr-00000000000000000003", 0, 10)).toHaveLength(2);
      expect(await store.pollTool("wr-00000000000000000003", 2, 10)).toEqual([]);
    });

    it("waits for the first event", async () => {
      const store = await create("wr-00000000000000000004", 1 << 20);
      const waiting = store.pollTool("wr-00000000000000000004", 0, 3000);
      setTimeout(() => void store.requestCollect("wr-00000000000000000004"), 50);
      expect(await waiting).toEqual([{ seq: 1, type: "collect" }]);
    });

    it("returns empty after waitMs and honours abort", async () => {
      const store = await create("wr-00000000000000000005", 1 << 20);
      expect(await store.pollTool("wr-00000000000000000005", 0, 50)).toEqual([]);
      const controller = new AbortController();
      const started = Date.now();
      setTimeout(() => controller.abort(), 30);
      expect(await store.pollTool("wr-00000000000000000005", 0, 5000, controller.signal)).toEqual([]);
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("applies back-pressure per run and frees it when acknowledged", async () => {
      const store = await create("wr-00000000000000000006", 40);
      const ch = await store.openChannel("wr-00000000000000000006");
      await store.fromAgent("wr-00000000000000000006", ch, 1, "x".repeat(30));
      await expect(store.fromAgent("wr-00000000000000000006", ch, 2, "x".repeat(30))).rejects.toBeInstanceOf(
        RelayBackpressureError,
      );
      await store.pollTool("wr-00000000000000000006", 2, 0); // acknowledge open + line
      await store.fromAgent("wr-00000000000000000006", ch, 2, "x".repeat(30));
    });

    it("does not return a channel poll early because of traffic on another channel", async () => {
      const token = "wr-00000000000000000008";
      const store = await create(token, 1 << 20);
      const c1 = await store.openChannel(token);
      const c2 = await store.openChannel(token);
      const started = Date.now();
      const waiting = store.pollAgent(token, c1, 0, 600);
      setTimeout(() => void store.fromTool(token, c2, 1, "other"), 50);
      setTimeout(() => void store.fromTool(token, c1, 1, "mine"), 250);
      expect(await waiting).toEqual([{ seq: 1, type: "line", line: "mine" }]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
      const idle = Date.now();
      const none = store.pollAgent(token, c2, 1, 300);
      setTimeout(() => void store.fromTool(token, c1, 2, "noise"), 50);
      expect(await none).toEqual([]);
      expect(Date.now() - idle).toBeGreaterThanOrEqual(250);
    });

    it("keeps channels separate and drops a relay", async () => {
      const store = await create("wr-00000000000000000007", 1 << 20);
      const a = await store.openChannel("wr-00000000000000000007");
      const b = await store.openChannel("wr-00000000000000000007");
      await store.fromTool("wr-00000000000000000007", b, 1, "only-b");
      expect(await store.pollAgent("wr-00000000000000000007", a, 0, 10)).toEqual([]);
      expect(await store.pollAgent("wr-00000000000000000007", b, 0, 10)).toHaveLength(1);
      await store.dropRelay("wr-00000000000000000007");
      await expect(store.pollAgent("wr-00000000000000000007", b, 0, 10)).rejects.toThrow("relay_unknown");
    });
  });
}
