import { describe, expect, it } from "vitest";
import type { JobHandle, JobLauncher, JobResult, JobSpec, JobStatus } from "./types.js";

export interface JobLauncherContractHarness {
  launcher: JobLauncher;
  spec: JobSpec;
  finish: (handle: JobHandle, result?: JobResult) => Promise<void>;
  lose: (handle: JobHandle) => Promise<void>;
}

export function jobLauncherContract(
  name: string,
  createHarness: () => JobLauncherContractHarness | Promise<JobLauncherContractHarness>,
): void {
  describe(`${name} JobLauncher contract`, () => {
    it("launches idempotently for the same run and identical spec", async () => {
      const { launcher, spec } = await createHarness();
      const first = await launcher.launch(spec);
      const second = await launcher.launch(structuredClone(spec));
      expect(second).toEqual(first);
    });

    it("rejects a conflicting duplicate launch", async () => {
      const { launcher, spec } = await createHarness();
      await launcher.launch(spec);
      await expect(launcher.launch({ ...spec, timeoutSec: spec.timeoutSec + 1 })).rejects.toThrow("job_spec_conflict");
    });

    it("reports legal active-to-terminal transitions without terminal regression", async () => {
      const { launcher, spec, finish } = await createHarness();
      const handle = await launcher.launch(spec);
      const first = await launcher.status(handle);
      expect(["pending", "running"]).toContain(first.state);
      await finish(handle);
      expect(await launcher.status(handle)).toEqual({ state: "succeeded" });
      await launcher.stop(handle, "too late");
      expect(await launcher.status(handle)).toEqual({ state: "succeeded" });
    });

    it("collects repeatably until idempotent removal", async () => {
      const { launcher, spec, finish } = await createHarness();
      const handle = await launcher.launch(spec);
      await finish(handle);
      const first = await launcher.collect(handle);
      const second = await launcher.collect(handle);
      expect(second).toEqual(first);

      await launcher.remove(handle);
      await launcher.remove(handle);
      await expect(launcher.collect(handle)).rejects.toThrow("job_removed");
      await expect(launcher.status(handle)).rejects.toThrow("job_removed");
    });

    it("refuses collection while work is active", async () => {
      const { launcher, spec } = await createHarness();
      const handle = await launcher.launch(spec);
      await expect(launcher.collect(handle)).rejects.toThrow("job_not_terminal");
    });

    it("stops idempotently and yields a stable stopped result", async () => {
      const { launcher, spec } = await createHarness();
      const handle = await launcher.launch(spec);
      await launcher.stop(handle, "cancelled");
      await launcher.stop(handle, "duplicate cancellation");
      expect(await launcher.status(handle)).toEqual({ state: "stopped" });
      expect(await launcher.collect(handle)).toEqual({ exitCode: 143, reason: "stopped" });
    });

    it("treats stop and remove of an unknown provider handle as idempotent cleanup", async () => {
      const { launcher, spec } = await createHarness();
      const handle = await launcher.launch(spec);
      const unknown = { ...handle, id: `${handle.id}-missing` };
      await expect(launcher.stop(unknown, "cleanup retry")).resolves.toBeUndefined();
      await expect(launcher.remove(unknown)).resolves.toBeUndefined();
    });

    it("does not remove an active job without an explicit stop", async () => {
      const { launcher, spec } = await createHarness();
      const handle = await launcher.launch(spec);
      await expect(launcher.remove(handle)).rejects.toThrow("job_not_terminal");
      expect((await launcher.status(handle)).state).toMatch(/pending|running/);
    });

    it("surfaces loss as a terminal, collectible result", async () => {
      const { launcher, spec, lose } = await createHarness();
      const handle = await launcher.launch(spec);
      await lose(handle);
      expect(await launcher.status(handle)).toEqual({ state: "lost" });
      expect(await launcher.collect(handle)).toEqual({ exitCode: 1, reason: "lost" });
    });

    it("never relaunches a removed run", async () => {
      const { launcher, spec, finish } = await createHarness();
      const handle = await launcher.launch(spec);
      await finish(handle);
      await launcher.remove(handle);
      expect(await launcher.launch(structuredClone(spec))).toEqual(handle);
      await expect(launcher.status(handle)).rejects.toThrow("job_removed");
    });

    it("returns defensive copies of handles, statuses, and results", async () => {
      const { launcher, spec, finish } = await createHarness();
      const handle = await launcher.launch(spec);
      handle.id = "mutated";
      const stable = await launcher.launch(spec);
      expect(stable.id).not.toBe("mutated");
      await finish(stable, { exitCode: 0, reason: "completed" });
      const status: JobStatus = await launcher.status(stable);
      const result = await launcher.collect(stable);
      expect(status).toEqual({ state: "succeeded" });
      expect(result).toMatchObject({ exitCode: 0, reason: "completed" });
    });
  });
}
