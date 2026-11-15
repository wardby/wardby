// One contract for every SubstrateRunStore (memory and Prisma): both must behave the same.
import { describe, expect, it } from "vitest";
import { retiredRunToken, substrateRunToken } from "./names.js";
import type { SubstrateRunRecord, SubstrateRunStore } from "./run-store.js";

export interface RunStoreContractSetup {
  /** A fresh store whose expiry checks use `now`. */
  store: (now: () => number) => SubstrateRunStore;
  /**
   * Makes `runIds` usable as SubstrateRun rows (Prisma: their Agent, Run and CodingRun) with no
   * SubstrateRun row of their own yet. Each id is unique to the calling test.
   */
  runs: (...runIds: string[]) => Promise<void>;
  /** A run id unique to this suite run (the Prisma suite shares a database). */
  id: (name: string) => string;
}

const NOW = Date.parse("2026-11-14T12:00:00Z");
const HOUR = 3_600_000;

export function describeSubstrateRunStoreContract(name: string, setup: RunStoreContractSetup): void {
  describe(`${name}: SubstrateRunStore contract`, () => {
    let now = NOW;
    const store = () => setup.store(() => now);
    const record = (runId: string, overrides: Partial<SubstrateRunRecord> = {}): SubstrateRunRecord => ({
      runId,
      token: substrateRunToken(runId),
      specHash: "h1",
      phase: "provisioning",
      deadlineAt: new Date(NOW + HOUR),
      ...overrides,
    });
    /** A claimed run moved to running, as a launch leaves it. */
    const running = async (s: SubstrateRunStore, runId: string, agentId?: string) => {
      await s.claim(record(runId, agentId !== undefined ? { agentId } : {}));
      return s.setPhase(runId, "running", ["provisioning"]);
    };
    const park = (s: SubstrateRunStore, runId: string, parkedAt: number, round = 1) =>
      s.park(runId, {
        headSha: "a".repeat(40),
        fingerprint: "f".repeat(64),
        parkedAt: new Date(parkedAt),
        round,
        expiresAt: new Date(parkedAt + HOUR),
      });

    it("fences a second claim, starts at round 1 and records the agent", async () => {
      now = NOW;
      const r1 = setup.id("claim");
      await setup.runs(r1);
      const s = store();
      const first = await s.claim(record(r1, { agentId: "agent-1" }));
      expect(first.created).toBe(true);
      expect(first.record).toMatchObject({ runId: r1, phase: "provisioning", round: 1, agentId: "agent-1" });
      expect(first.record.parkedAt).toBeUndefined();
      expect(first.record.headSha).toBeUndefined();
      const second = await s.claim(record(r1, { specHash: "h2" }));
      expect(second).toMatchObject({ created: false, record: { specHash: "h1", agentId: "agent-1" } });
      expect(await s.get(r1)).toMatchObject({ runId: r1, round: 1 });
      expect(await s.getByToken(substrateRunToken(r1))).toMatchObject({ runId: r1 });
      expect(await s.getByToken("wr-ffffffffffffffffffff")).toBeUndefined();
    });

    it("moves phase only from an allowed phase", async () => {
      const r1 = setup.id("phase");
      await setup.runs(r1);
      const s = store();
      await s.claim(record(r1));
      await expect(s.setPhase(r1, "running", ["requeued"])).rejects.toThrow("substrate_phase_conflict");
      expect((await s.setPhase(r1, "running", ["provisioning"])).phase).toBe("running");
      await expect(s.setPhase(setup.id("missing"), "running")).rejects.toThrow("substrate_phase_conflict");
    });

    it("reclaims only a requeued run, at round 1, with a fresh deadline", async () => {
      now = NOW;
      const from = setup.id("reclaim-from");
      const r2 = setup.id("reclaim");
      await setup.runs(from, r2);
      const s = store();
      await running(s, from);
      await park(s, from, NOW);
      // An adopter at round 2, then refused for capacity.
      await s.adopt(from, r2, new Date(NOW + HOUR), { specHash: "h2" });
      const later = new Date(NOW + 2 * HOUR);
      expect(await s.reclaim(r2, later)).toBeUndefined();
      await s.setPhase(r2, "requeued", ["provisioning"]);
      const reclaimed = await s.reclaim(r2, later, { coldReason: "capacity" });
      expect(reclaimed).toMatchObject({ phase: "provisioning", deadlineAt: later, round: 1, coldReason: "capacity" });
      expect(await s.get(r2)).toMatchObject({ coldReason: "capacity" });
      expect(await s.reclaim(r2, later)).toBeUndefined();
    });

    it("records a cold continuation's reason on claim; none otherwise", async () => {
      const r1 = setup.id("cold");
      const r2 = setup.id("plain");
      await setup.runs(r1, r2);
      const s = store();
      expect((await s.claim(record(r1, { coldReason: "branch_moved" }))).record.coldReason).toBe("branch_moved");
      expect(await s.get(r1)).toMatchObject({ coldReason: "branch_moved" });
      expect((await s.claim(record(r2))).record.coldReason).toBeUndefined();
      expect((await s.get(r2))!.coldReason).toBeUndefined();
    });

    it("records the actor shape on claim (single or pair) and keeps it through reclaim and setPhase", async () => {
      now = NOW;
      const single = setup.id("shape-single");
      const pair = setup.id("shape-pair");
      await setup.runs(single, pair);
      const s = store();
      expect((await s.claim(record(single, { actorShape: "single" }))).record.actorShape).toBe("single");
      expect((await s.claim(record(pair))).record.actorShape).toBe("pair");
      expect((await s.get(single))?.actorShape).toBe("single");
      expect((await s.getByToken(substrateRunToken(single)))?.actorShape).toBe("single");
      expect((await s.get(pair))?.actorShape).toBe("pair");
      expect((await s.setPhase(single, "requeued", ["provisioning"])).actorShape).toBe("single");
      expect((await s.reclaim(single, new Date(NOW + HOUR)))?.actorShape).toBe("single");
      expect((await s.setPhase(single, "running", ["provisioning"])).actorShape).toBe("single");
    });

    it("gives an adopter the pair shape", async () => {
      now = NOW;
      const r1 = setup.id("shape-adopt-1");
      const r2 = setup.id("shape-adopt-2");
      await setup.runs(r1, r2);
      const s = store();
      await s.claim(record(r1, { actorShape: "single" }));
      await s.setPhase(r1, "running", ["provisioning"]);
      await park(s, r1, NOW);
      const adopted = await s.adopt(r1, r2, new Date(NOW + HOUR), { specHash: "h2" });
      expect(adopted?.actorShape).toBe("pair");
      expect((await s.getByToken(substrateRunToken(r1)))?.actorShape).toBe("pair");
    });

    it("records the repositories on claim, names and access only, and keeps them through reclaim and setPhase", async () => {
      now = NOW;
      const r = setup.id("repos");
      const r2 = setup.id("repos-none");
      const r3 = setup.id("repos-secret");
      await setup.runs(r, r2, r3);
      const s = store();
      const REPOS = [
        { name: "extra-alpha", access: "write" as const },
        { name: "extra-beta", access: "read" as const },
      ];
      expect((await s.claim(record(r, { repositories: REPOS }))).record.repositories).toEqual(REPOS);
      expect((await s.get(r))?.repositories).toEqual(REPOS);
      expect((await s.getByToken(substrateRunToken(r)))?.repositories).toEqual(REPOS);
      expect((await s.setPhase(r, "requeued", ["provisioning"])).repositories).toEqual(REPOS);
      expect((await s.reclaim(r, new Date(NOW + HOUR)))?.repositories).toEqual(REPOS);
      expect((await s.setPhase(r, "running", ["provisioning"])).repositories).toEqual(REPOS);

      await s.claim(record(r2));
      expect("repositories" in (await s.get(r2))!).toBe(false);

      await s.claim(
        record(r3, {
          repositories: [
            { name: "extra-alpha", access: "write", hostPath: "/runs/r3/repos/extra-alpha/workspace" },
          ] as never,
        }),
      );
      const stored = JSON.stringify(await s.get(r3));
      expect(stored).not.toContain('"hostPath"');
      expect(stored).not.toContain("/runs/");
    });

    it("gives an adopter no repositories", async () => {
      now = NOW;
      const r1 = setup.id("repos-adopt-1");
      const r2 = setup.id("repos-adopt-2");
      await setup.runs(r1, r2);
      const s = store();
      await s.claim(record(r1));
      await s.setPhase(r1, "running", ["provisioning"]);
      await park(s, r1, NOW);
      const adopted = await s.adopt(r1, r2, new Date(NOW + HOUR), { specHash: "h2" });
      expect(adopted).toBeDefined();
      expect("repositories" in adopted!).toBe(false);
    });

    it("records the services on claim, sorted, and keeps them through reclaim and setPhase", async () => {
      now = NOW;
      const r = setup.id("services");
      const r2 = setup.id("services-none");
      await setup.runs(r, r2);
      const s = store();
      const SORTED = ["postgres", "redis"];
      expect((await s.claim(record(r, { services: ["redis", "postgres"] }))).record.services).toEqual(SORTED);
      expect((await s.get(r))?.services).toEqual(SORTED);
      expect((await s.getByToken(substrateRunToken(r)))?.services).toEqual(SORTED);
      expect((await s.setPhase(r, "requeued", ["provisioning"])).services).toEqual(SORTED);
      expect((await s.reclaim(r, new Date(NOW + HOUR)))?.services).toEqual(SORTED);
      expect((await s.setPhase(r, "running", ["provisioning"])).services).toEqual(SORTED);
      expect("servicesUnreadable" in (await s.get(r))!).toBe(false);

      await s.claim(record(r2));
      const none = await s.get(r2);
      expect("services" in none!).toBe(false);
      expect("servicesUnreadable" in none!).toBe(false);
    });

    it("refuses services that are not catalog names, or none, on claim", async () => {
      now = NOW;
      const r = setup.id("services-bad");
      await setup.runs(r);
      const s = store();
      for (const services of [[], ["Postgres"], ["postgres", "not a name"], ["../etc"]]) {
        await expect(s.claim(record(r, { services }))).rejects.toThrow("substrate_services_invalid");
      }
      expect(await s.get(r)).toBeUndefined();
    });

    it("gives an adopter no services", async () => {
      now = NOW;
      const r1 = setup.id("services-adopt-1");
      const r2 = setup.id("services-adopt-2");
      await setup.runs(r1, r2);
      const s = store();
      await s.claim(record(r1));
      await s.setPhase(r1, "running", ["provisioning"]);
      await park(s, r1, NOW);
      const adopted = await s.adopt(r1, r2, new Date(NOW + HOUR), { specHash: "h2" });
      expect(adopted).toBeDefined();
      expect("services" in adopted!).toBe(false);
      expect("servicesUnreadable" in adopted!).toBe(false);
    });

    it("parks only a running run, with what it was parked with", async () => {
      now = NOW;
      const r1 = setup.id("park");
      await setup.runs(r1);
      const s = store();
      await s.claim(record(r1));
      await expect(park(s, r1, NOW)).rejects.toThrow("substrate_phase_conflict");
      await s.setPhase(r1, "running", ["provisioning"]);
      const parked = await park(s, r1, NOW, 3);
      expect(parked).toMatchObject({
        phase: "parked",
        headSha: "a".repeat(40),
        fingerprint: "f".repeat(64),
        parkedAt: new Date(NOW),
        round: 3,
        deadlineAt: new Date(NOW + HOUR),
      });
      expect(await s.get(r1)).toMatchObject({ phase: "parked", round: 3, parkedAt: new Date(NOW) });
      await expect(park(s, r1, NOW)).rejects.toThrow("substrate_phase_conflict");
      await expect(park(s, setup.id("park-missing"), NOW)).rejects.toThrow("substrate_phase_conflict");
    });

    it("adopts a parked run in one step: retired token, same token on the adopter, round + 1", async () => {
      now = NOW;
      const r1 = setup.id("adopt-1");
      const r2 = setup.id("adopt-2");
      const r3 = setup.id("adopt-3");
      await setup.runs(r1, r2, r3);
      const s = store();
      await running(s, r1, "agent-1");
      const deadline = new Date(NOW + 2 * HOUR);
      // Not parked yet.
      expect(await s.adopt(r1, r2, deadline, { specHash: "h2" })).toBeUndefined();
      expect(await s.get(r2)).toBeUndefined();
      await park(s, r1, NOW);
      const adopted = await s.adopt(r1, r2, deadline, { specHash: "h2", agentId: "agent-1" });
      expect(adopted).toMatchObject({
        runId: r2,
        token: substrateRunToken(r1),
        specHash: "h2",
        phase: "provisioning",
        deadlineAt: deadline,
        round: 2,
        agentId: "agent-1",
      });
      expect(adopted!.parkedAt).toBeUndefined();
      expect(await s.get(r1)).toMatchObject({ phase: "adopted", token: retiredRunToken(r1), round: 1 });
      expect(await s.getByToken(substrateRunToken(r1))).toMatchObject({ runId: r2 });
      // Adopted once only.
      expect(await s.adopt(r1, r3, deadline, { specHash: "h3" })).toBeUndefined();
      expect(await s.get(r3)).toBeUndefined();
    });

    it("chains: the adopter parks at its round, and the next adopter is at round 3 on the same token", async () => {
      now = NOW;
      const [r1, r2, r3] = [setup.id("chain-1"), setup.id("chain-2"), setup.id("chain-3")];
      await setup.runs(r1, r2, r3);
      const s = store();
      await running(s, r1);
      await park(s, r1, NOW);
      const second = (await s.adopt(r1, r2, new Date(NOW + HOUR), { specHash: "h2" }))!;
      await s.setPhase(r2, "running", ["provisioning"]);
      await park(s, r2, NOW + 1_000, second.round);
      expect(await s.adopt(r2, r3, new Date(NOW + HOUR), { specHash: "h3" })).toMatchObject({
        token: substrateRunToken(r1),
        round: 3,
      });
      expect(await s.get(r2)).toMatchObject({ phase: "adopted", token: retiredRunToken(r2), round: 2 });
    });

    it("does not adopt an expired park, and changes nothing", async () => {
      now = NOW;
      const r1 = setup.id("expired-1");
      const r2 = setup.id("expired-2");
      await setup.runs(r1, r2);
      const s = store();
      await running(s, r1);
      await park(s, r1, NOW);
      now = NOW + HOUR;
      expect(await s.adopt(r1, r2, new Date(now + HOUR), { specHash: "h2" })).toBeUndefined();
      expect(await s.get(r1)).toMatchObject({ phase: "parked", token: substrateRunToken(r1) });
      expect(await s.get(r2)).toBeUndefined();
      now = NOW;
    });

    it("rolls the adoption back when the adopter already has a row", async () => {
      now = NOW;
      const r1 = setup.id("taken-1");
      const r2 = setup.id("taken-2");
      await setup.runs(r1, r2);
      const s = store();
      await running(s, r1);
      await park(s, r1, NOW);
      await s.claim(record(r2));
      expect(await s.adopt(r1, r2, new Date(NOW + HOUR), { specHash: "h2" })).toBeUndefined();
      expect(await s.get(r1)).toMatchObject({ phase: "parked", token: substrateRunToken(r1) });
      expect(await s.get(r2)).toMatchObject({ token: substrateRunToken(r2), round: 1 });
    });

    it("lists parked runs oldest park first, with olderThan and limit, and counts them", async () => {
      now = NOW;
      const [a, b, c, d] = [setup.id("list-a"), setup.id("list-b"), setup.id("list-c"), setup.id("list-d")];
      await setup.runs(a, b, c, d);
      const s = store();
      const before = await s.countParked();
      for (const id of [a, b, c, d]) await running(s, id);
      // Parked out of id order; d stays running.
      await park(s, b, NOW - 3_000);
      await park(s, c, NOW - 2_000);
      await park(s, a, NOW - 1_000);
      const mine = (rows: SubstrateRunRecord[]) => rows.map((r) => r.runId).filter((id) => [a, b, c, d].includes(id));
      expect(mine(await s.listParked())).toEqual([b, c, a]);
      expect(mine(await s.listParked({ olderThan: new Date(NOW - 1_500) }))).toEqual([b, c]);
      expect(await s.countParked()).toBe(before + 3);
      // limit counts every parked run (other suites' too), so check it on a fresh view: at most n, oldest first.
      const limited = await s.listParked({ limit: 1 });
      expect(limited).toHaveLength(1);
      expect((await s.listParked())[0].runId).toBe(limited[0].runId);
      expect(await s.listParked({ limit: 0 })).toEqual([]);
      await expect(s.listParked({ limit: -1 })).rejects.toThrow("substrate_list_limit_invalid");
    });
  });
}
