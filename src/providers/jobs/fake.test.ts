import { describe, expect, it } from "vitest";
import { jobLauncherContract } from "./contract-suite.js";
import { FakeJobLauncher } from "./fake.js";
import type { JobSpec } from "./types.js";

function spec(runId = "run-1"): JobSpec {
  return {
    kind: "coding-agent",
    runId,
    image: "registry.example/wardby-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    inputArtifact: "/artifacts/input.json",
    timeoutSec: 900,
    limits: { cpus: 2, memoryMb: 2048, pids: 128, diskMb: 4096 },
    labels: { "wardby.run-id": runId, "wardby.schema": "1" },
  };
}

jobLauncherContract("Fake", () => {
  const launcher = new FakeJobLauncher();
  return {
    launcher,
    spec: spec(),
    finish: (handle, result) => launcher.finish(handle, result),
    lose: (handle) => launcher.lose(handle),
  };
});

describe("FakeJobLauncher controls", () => {
  it("replays delayed status transitions deterministically", async () => {
    const launcher = new FakeJobLauncher();
    launcher.queuePlan({
      statusScript: [{ state: "pending" }, { state: "running" }, { state: "succeeded" }],
      result: { exitCode: 0, reason: "completed", resultArtifact: '{"schemaVersion":1}' },
    });
    const handle = await launcher.launch(spec());

    expect(await launcher.status(handle)).toEqual({ state: "pending" });
    expect(await launcher.status(handle)).toEqual({ state: "running" });
    expect(await launcher.status(handle)).toEqual({ state: "succeeded" });
    expect(await launcher.status(handle)).toEqual({ state: "succeeded" });
    expect(await launcher.collect(handle)).toEqual({
      exitCode: 0,
      reason: "completed",
      resultArtifact: '{"schemaVersion":1}',
    });
  });

  it("can return malformed artifacts for boundary-validation tests", async () => {
    const launcher = new FakeJobLauncher();
    const handle = await launcher.launch(spec());
    await launcher.finish(handle, { exitCode: 0, reason: "completed", resultArtifact: "not-json" });
    expect((await launcher.collect(handle)).resultArtifact).toBe("not-json");
  });

  it("makes stop-versus-completion races converge on the first terminal state", async () => {
    const stopFirst = new FakeJobLauncher();
    const stopped = await stopFirst.launch(spec("run-stop-first"));
    await Promise.all([stopFirst.stop(stopped, "cancelled"), stopFirst.finish(stopped)]);
    expect(await stopFirst.status(stopped)).toEqual({ state: "stopped" });

    const finishFirst = new FakeJobLauncher();
    const finished = await finishFirst.launch(spec("run-finish-first"));
    await Promise.all([finishFirst.finish(finished), finishFirst.stop(finished, "cancelled")]);
    expect(await finishFirst.status(finished)).toEqual({ state: "succeeded" });
  });

  it("models timeout as a failed status with a collectible timed-out result", async () => {
    const launcher = new FakeJobLauncher();
    const handle = await launcher.launch(spec());
    await launcher.finish(handle, { exitCode: 124, reason: "timed_out" });
    expect(await launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
    expect(await launcher.collect(handle)).toEqual({ exitCode: 124, reason: "timed_out" });
  });

  it("rejects running-to-pending regression in a scripted adapter response", async () => {
    const launcher = new FakeJobLauncher();
    launcher.queuePlan({ statusScript: [{ state: "running" }, { state: "pending" }] });
    const handle = await launcher.launch(spec());
    expect(await launcher.status(handle)).toEqual({ state: "running" });
    await expect(launcher.status(handle)).rejects.toThrow("job_illegal_transition");
  });

  it("rejects a terminal status that disagrees with its planned result", async () => {
    const launcher = new FakeJobLauncher();
    launcher.queuePlan({
      statusScript: [{ state: "succeeded" }],
      result: { exitCode: 1, reason: "failed" },
    });
    const handle = await launcher.launch(spec());
    await expect(launcher.status(handle)).rejects.toThrow("job_result_status_mismatch");
  });
});
