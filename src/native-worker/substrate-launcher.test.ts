import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SubstrateExhaustedError,
  SubstrateNotFoundError,
  SubstrateUnavailableError,
} from "../providers/substrate/api.js";
import { nativeActorName, substrateRunToken } from "../providers/substrate/names.js";
import { NATIVE_SANDBOX_LAUNCH_ABANDONED } from "./launch.js";
import { canaryCapabilityHash, type MemoryNativeCanaryStore } from "./substrate-canary-store.js";
import {
  FAKE_NATIVE_CAP,
  FAKE_PROMPT,
  failNextCanary,
  fakePower,
  NATIVE_CONFIG,
  nativeHarness,
} from "./substrate-launcher.test-support.js";
import { nativeCanaryEgress, nativeEgress, nativeTemplate } from "./substrate-specs.js";

const substrateWarn = vi.hoisted(() => vi.fn());
const substrateInfo = vi.hoisted(() => vi.fn());
vi.mock("../core/logger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/logger.js")>();
  const child = real.logger.child.bind(real.logger);
  vi.spyOn(real.logger, "child").mockImplementation((bindings, options) => {
    const log = child(bindings, options);
    if (bindings.module === "native-substrate-launcher") {
      vi.spyOn(log, "warn").mockImplementation(substrateWarn);
      vi.spyOn(log, "info").mockImplementation(substrateInfo);
    }
    return log;
  });
  return real;
});

beforeEach(() => {
  substrateWarn.mockReset();
  substrateInfo.mockReset();
});

const CAPACITY = "native_sandbox_capacity: no Substrate worker has room for another native worker.";

/** Nothing of the run is left: no actor, no policy, no Secret. */
function expectNothingLeft(h: ReturnType<typeof nativeHarness>) {
  expect(h.api.actors.has(h.actorKey)).toBe(false);
  expect(h.api.egressPolicies.has(h.actorKey)).toBe(false);
  expect(h.secrets.secrets.has(h.secretKey)).toBe(false);
}

/** A promise and its resolver. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe("SubstrateNativeWorkerLauncher.launch", () => {
  it("launches in order: template, Secret, actor, policy, resume", async () => {
    const h = nativeHarness();
    await h.launcher.launch(h.input());
    // The handle's own polls (getActor) are not part of the launch.
    expect(h.order.filter((c) => c !== "getActor")).toEqual([
      "ensureActorTemplate",
      "getActorTemplate",
      "listWorkers",
      "createSecret",
      "createActor",
      "putEgressPolicy",
      "resumeActor",
    ]);
    expect(h.actorKey).toBe(`wardby-runs/${h.token}-native`);
    expect(h.api.actors.get(h.actorKey)?.state).toBe("RUNNING");
    expect(h.api.actors.get(h.actorKey)?.templateName).toBe(nativeTemplate(h.config).name);
    expect(h.api.egressPolicies.get(h.actorKey)).toEqual(nativeEgress(h.token, h.config));
    expect(h.secrets.secrets.get(`wardby-run-credentials/${h.token}`)?.stringData).toEqual({
      capability: FAKE_NATIVE_CAP,
    });
    expect(h.failures).toEqual([]);
  });

  it("is ready at launch and dials the configured gateway", async () => {
    const h = nativeHarness();
    expect(h.launcher.networkReadyAtLaunch).toBe(true);
    expect(await h.launcher.resolveGatewayUrl()).toBe(h.config.gatewayUrl);
  });

  it("never sends the input anywhere", async () => {
    const h = nativeHarness();
    await h.launcher.launch(h.input());
    const text = JSON.stringify([...h.api.templates.values(), ...h.api.egressPolicies.values(), h.api.calls]);
    expect(text).not.toContain(FAKE_NATIVE_CAP);
    expect(text).not.toContain(FAKE_PROMPT);
    expect(JSON.stringify(substrateWarn.mock.calls)).not.toContain(FAKE_NATIVE_CAP);
  });

  it("refuses an input without a gateway before anything else", async () => {
    const h = nativeHarness();
    const { gateway: _gateway, ...bare } = h.input();
    await expect(h.launcher.launch(bare)).rejects.toThrow(/^native_sandbox_substrate_failed: launch: input_invalid$/);
    expect(h.order).toEqual([]);
  });

  it("recreates a stale actor, never takes it over", async () => {
    const h = nativeHarness();
    const template = nativeTemplate(h.config);
    await h.api.ensureActorTemplate(template);
    await h.api.createActor(h.config.atespace, h.actor, template.name);
    await h.api.resumeActor(h.config.atespace, h.actor);
    await h.api.putEgressPolicy(h.config.atespace, h.actor, [{ kind: "http", hostnames: ["stale.example"] }]);
    h.order.length = 0;
    await h.launcher.launch(h.input());
    const after = h.order.slice(h.order.indexOf("createActor"));
    expect(after.slice(0, 4)).toEqual(["createActor", "deleteEgressPolicy", "deleteActor", "createActor"]);
    expect(h.order.filter((c) => c === "deleteEgressPolicy")).toHaveLength(1);
    expect(h.order.filter((c) => c === "deleteActor")).toHaveLength(1);
    expect(h.api.actors.get(h.actorKey)?.state).toBe("RUNNING");
    expect(h.api.egressPolicies.get(h.actorKey)).toEqual(nativeEgress(h.token, h.config));
  });

  it("recreates a golden-failed template once", async () => {
    const h = nativeHarness();
    const template = nativeTemplate(h.config);
    await h.api.ensureActorTemplate(template);
    h.api.failGoldenSnapshot(h.config.atespace, template.name);
    h.order.length = 0;
    await h.launcher.launch(h.input());
    expect(h.order.filter((c) => c === "deleteActorTemplate")).toHaveLength(1);
    expect(h.api.actors.get(h.actorKey)?.state).toBe("RUNNING");
  });

  it("waits within the golden window, then succeeds", async () => {
    const h = nativeHarness();
    h.api.failNext("resumeActor", () => new SubstrateExhaustedError("no room yet"), 2);
    await h.launcher.launch(h.input());
    expect(h.order.filter((c) => c === "resumeActor")).toHaveLength(3);
    expect(h.sleeps).toEqual([2_000, 2_000]);
    // The template is rechecked before each retry.
    expect(h.order.slice(h.order.indexOf("resumeActor")).filter((c) => c !== "getActor")).toEqual([
      "resumeActor",
      "getActorTemplate",
      "resumeActor",
      "getActorTemplate",
      "resumeActor",
    ]);
    expect(h.failures).toEqual([]);
  });

  it("reports capacity past the golden window and leaves nothing", async () => {
    const h = nativeHarness({ goldenWaitMs: 60_000 });
    await h.launcher.start();
    // Let the background ensure finish at the first clock reading.
    await vi.waitFor(() => expect(h.order).toContain("getActorTemplate"));
    h.setNow(h.now() + 61_000);
    h.api.failNext("resumeActor", () => new SubstrateExhaustedError("quoting " + FAKE_NATIVE_CAP), 100);
    const err = (await h.launcher.launch(h.input()).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe(CAPACITY);
    expect(h.order.filter((c) => c === "resumeActor")).toHaveLength(1);
    expectNothingLeft(h);
    expect(h.failures).toEqual([
      { runId: "run-1", substrateCall: "resumeActor", errorCode: "substrate_resource_exhausted" },
    ]);
  });

  it("gives up once the golden window passes while it waits", async () => {
    const h = nativeHarness({ goldenWaitMs: 10_000 });
    h.api.failNext("resumeActor", () => new SubstrateExhaustedError("x"), 100);
    await expect(h.launcher.launch(h.input())).rejects.toThrow(CAPACITY);
    // Retries at 0, 2, 4, 6, 8 s; at 10 s the window has passed.
    expect(h.order.filter((c) => c === "resumeActor")).toHaveLength(6);
    expectNothingLeft(h);
  });

  it("fails a golden build that fails during the wait", async () => {
    const h = nativeHarness();
    h.api.failNext("resumeActor", () => {
      h.api.failGoldenSnapshot(h.config.atespace, nativeTemplate(h.config).name);
      return new SubstrateExhaustedError("no room yet");
    });
    const err = (await h.launcher.launch(h.input()).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("native_sandbox_substrate_failed: getActorTemplate: golden_snapshot_failed");
    expectNothingLeft(h);
    expect(h.failures).toEqual([
      { runId: "run-1", substrateCall: "getActorTemplate", errorCode: "golden_snapshot_failed" },
    ]);
  });

  it("refuses before creating anything when no worker has room", async () => {
    const small = nativeHarness({ fake: { workerSize: { cpuMillicores: 500, memoryBytes: 2 ** 30 } } });
    await expect(small.launcher.launch(small.input())).rejects.toThrow(CAPACITY);
    expect(small.secrets.calls).toEqual([]);
    expect(small.api.actors.size).toBe(0);
    expect(small.order).not.toContain("createActor");

    const elsewhere = nativeHarness({
      fake: { workerLabels: { pool: "other" } },
      config: { workerSelector: { pool: "native" } },
    });
    await expect(elsewhere.launcher.launch(elsewhere.input())).rejects.toThrow(CAPACITY);
    expect(elsewhere.secrets.calls).toEqual([]);
    expect(elsewhere.api.actors.size).toBe(0);
  });

  it("skips the room check when the workers cannot be listed", async () => {
    const h = nativeHarness();
    h.api.failNext("listWorkers", new SubstrateUnavailableError("quoting " + FAKE_NATIVE_CAP));
    await h.launcher.launch(h.input());
    expect(h.api.actors.get(h.actorKey)?.state).toBe("RUNNING");
    expect(h.failures).toEqual([{ runId: "run-1", substrateCall: "listWorkers", errorCode: "substrate_unavailable" }]);
  });

  it("replaces a Secret left by an earlier attempt", async () => {
    const h = nativeHarness();
    await h.secrets.createSecret(h.config.credentialsNamespace, {
      metadata: { name: h.token },
      stringData: { capability: "stale" },
    });
    h.order.length = 0;
    await h.launcher.launch(h.input());
    expect(h.order.filter((c) => c.endsWith("Secret"))).toEqual(["createSecret", "deleteSecret", "createSecret"]);
    expect(h.secrets.secrets.get(h.secretKey)?.stringData).toEqual({ capability: FAKE_NATIVE_CAP });
  });

  it("fails a Secret it cannot create with a fixed code, and leaves nothing", async () => {
    const h = nativeHarness();
    const real = h.secrets.createSecret.bind(h.secrets);
    // The run's Secret fails; the startup canary's own Secret is made as usual.
    h.secrets.createSecret = async (namespace, body) => {
      if (body.metadata?.name?.endsWith("-canary")) return real(namespace, body);
      throw new Error("secrets is forbidden: " + FAKE_NATIVE_CAP);
    };
    const err = (await h.launcher.launch(h.input()).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("native_sandbox_substrate_failed: createSecret: unexpected");
    expect(h.failures).toEqual([{ runId: "run-1", substrateCall: "createSecret", errorCode: "unexpected" }]);
    expect(h.api.actors.size).toBe(0);
  });

  it.each([
    ["createActor", () => new SubstrateUnavailableError("quoting " + FAKE_NATIVE_CAP)],
    ["putEgressPolicy", () => new SubstrateNotFoundError("quoting " + FAKE_NATIVE_CAP)],
    ["resumeActor", () => new SubstrateUnavailableError("quoting " + FAKE_NATIVE_CAP)],
    ["ensureActorTemplate", () => new Error("quoting template " + FAKE_NATIVE_CAP)],
  ] as const)("maps a failed %s to a fixed code and cleans up", async (substrateCall, error) => {
    const h = nativeHarness();
    h.api.failNext(substrateCall, error);
    const err = (await h.launcher.launch(h.input()).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^native_sandbox_substrate_failed: [a-zA-Z]+: [a-z_]+$/);
    expect(err.message).toContain(`: ${substrateCall}: `);
    if (substrateCall === "ensureActorTemplate") {
      expect(err.message).toBe("native_sandbox_substrate_failed: ensureActorTemplate: unexpected");
    }
    expect(err.message).not.toContain(FAKE_NATIVE_CAP);
    expect(err.cause).toBeUndefined();
    expectNothingLeft(h);
    expect(h.failures).toEqual([{ runId: "run-1", substrateCall, errorCode: substrateErrorCodeOf(error()) }]);
  });

  it("reports a failed call to the module log with fixed fields only by default", async () => {
    const h = nativeHarness({ launcher: { onCallFailed: undefined } });
    h.api.failNext("createActor", new SubstrateUnavailableError("quoting " + FAKE_NATIVE_CAP));
    await expect(h.launcher.launch(h.input())).rejects.toThrow();
    expect(substrateWarn).toHaveBeenCalledWith(
      { runId: "run-1", substrateCall: "createActor", errorCode: "substrate_unavailable" },
      "substrate_call_failed",
    );
    expect(JSON.stringify(substrateWarn.mock.calls)).not.toContain(FAKE_NATIVE_CAP);
  });

  it("fails at once for room when the template's golden snapshot is already ready", async () => {
    const h = nativeHarness();
    const template = nativeTemplate(h.config);
    await h.api.ensureActorTemplate(template);
    h.api.setGoldenSnapshotReady(h.config.atespace, template.name, true);
    h.api.failNext("resumeActor", () => new SubstrateExhaustedError("x"), 100);
    await expect(h.launcher.launch(h.input())).rejects.toThrow(CAPACITY);
    expect(h.order.filter((c) => c === "resumeActor")).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expectNothingLeft(h);
  });

  it("abandons a run that ended during the golden wait", async () => {
    const h = nativeHarness();
    h.api.failNext("resumeActor", () => new SubstrateExhaustedError("x"), 100);
    let checks = 0;
    const err = (await h.launcher
      // Wanted after the wake and after the canary; ended during the golden wait.
      .launch(h.input(), { stillWanted: async () => ++checks <= 2 })
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(new RegExp(`^${NATIVE_SANDBOX_LAUNCH_ABANDONED}: `));
    expect(h.order.filter((c) => c === "resumeActor")).toHaveLength(1);
    expectNothingLeft(h);
  });

  it("still deletes the Secret when its clean-up cannot delete the actor, and leaves the actor to remove", async () => {
    const h = nativeHarness();
    h.api.failNext("resumeActor", new SubstrateUnavailableError("quoting " + FAKE_NATIVE_CAP));
    h.api.failNext("deleteActor", new SubstrateUnavailableError("quoting " + FAKE_NATIVE_CAP));
    const err = (await h.launcher.launch(h.input()).catch((e: unknown) => e)) as Error;
    // The launch's own failure is the run error; the clean-up's is reported.
    expect(err.message).toBe("native_sandbox_substrate_failed: resumeActor: substrate_unavailable");
    expect(h.secrets.secrets.has(h.secretKey)).toBe(false);
    // Policy first: an actor with no policy is offline (Substrate's egress is default-deny).
    expect(h.api.egressPolicies.has(h.actorKey)).toBe(false);
    expect(h.api.actors.has(h.actorKey)).toBe(true);
    expect(h.failures).toEqual([
      { runId: "run-1", substrateCall: "resumeActor", errorCode: "substrate_unavailable" },
      { runId: "run-1", substrateCall: "deleteActor", errorCode: "substrate_unavailable" },
    ]);
    expect(JSON.stringify(h.failures)).not.toContain(FAKE_NATIVE_CAP);
    // The ended session keeps workerRemovedAt null, so the executor's sweep calls remove (Task 6).
    await h.launcher.remove("run-1");
    expectNothingLeft(h);
  });

  it("abandons a run stopped during a slow canary: no Secret, no actor", async () => {
    const h = nativeHarness();
    const canaryResumed = deferred();
    const release = deferred();
    h.api.canaryBefore.resumeActor = async () => {
      canaryResumed.resolve();
      await release.promise;
    };
    let wanted = true;
    const launching = h.launcher.launch(h.input(), { stillWanted: async () => wanted }).catch((e: unknown) => e);
    await canaryResumed.promise;
    // stop_run lands while the canary is still waiting for its verdict.
    wanted = false;
    release.resolve();
    const err = (await launching) as Error;
    expect(err.message).toMatch(new RegExp(`^${NATIVE_SANDBOX_LAUNCH_ABANDONED}: `));
    expect(h.secrets.calls).toEqual([]);
    expect(h.api.calls.filter((c) => c.method === "createActor")).toEqual([]);
    expectNothingLeft(h);
  });

  it("abandons a run stopped while its actor resumed, and removes what it created", async () => {
    const h = nativeHarness();
    let wanted = true;
    h.api.before.resumeActor = async () => {
      wanted = false;
    };
    const err = (await h.launcher
      .launch(h.input(), { stillWanted: async () => wanted })
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(new RegExp(`^${NATIVE_SANDBOX_LAUNCH_ABANDONED}: `));
    expect(h.order.filter((c) => c === "resumeActor")).toHaveLength(1);
    expectNothingLeft(h);
  });

  it("abandons a run that ended while waking", async () => {
    const ensureAwake = vi.fn(async () => {});
    const h = nativeHarness({ power: fakePower(ensureAwake) });
    const err = (await h.launcher
      .launch(h.input(), { stillWanted: async () => false })
      .catch((e: unknown) => e)) as Error;
    expect(ensureAwake).toHaveBeenCalledWith("gateway", { timeoutMs: expect.any(Number), runId: "run-1" });
    expect(err.message).toMatch(new RegExp(`^${NATIVE_SANDBOX_LAUNCH_ABANDONED}: `));
    expect(h.order).toEqual([]);
    expect(h.secrets.calls).toEqual([]);
  });
});

/** The fixed code the shared mapping gives an error (unexpected for a non-Substrate one). */
function substrateErrorCodeOf(error: Error): string {
  return (error as { code?: string }).code ?? "unexpected";
}

describe("SubstrateNativeWorkerLauncher state", () => {
  it("maps the actor's state for the executor", async () => {
    const h = nativeHarness();
    expect(await h.launcher.inspect("run-1")).toEqual({ state: "missing" });
    h.sessions.set("run-1", true);
    const handle = await h.launcher.launch(h.input());
    expect(await h.launcher.inspect("run-1")).toEqual({ state: "running" });
    h.sessions.set("run-1", false);
    expect(await h.launcher.inspect("run-1")).toEqual({ state: "exited", exitCode: 0 });
    h.api.setState(h.config.atespace, h.actor, "CRASHED");
    expect(await h.launcher.inspect("run-1")).toEqual({ state: "exited", exitCode: 1 });
    // Its handle settles here, not in a later test.
    await handle.exited;
  });

  it("reports the exit code the supervisor reported, while the actor itself stays RUNNING", async () => {
    const h = nativeHarness();
    h.sessions.set("run-1", true);
    const handle = await h.launcher.launch(h.input());
    expect(await h.launcher.inspect("run-1")).toEqual({ state: "running" });
    h.exits.set("run-1", 1);
    expect(h.api.actors.get(h.actorKey)?.state).toBe("RUNNING");
    expect(await h.launcher.inspect("run-1")).toEqual({ state: "exited", exitCode: 1 });
    // A reported exit stands whether or not the session has ended.
    h.sessions.set("run-1", false);
    expect(await h.launcher.inspect("run-1")).toEqual({ state: "exited", exitCode: 1 });
    h.exits.set("run-1", 0);
    expect(await h.launcher.inspect("run-1")).toEqual({ state: "exited", exitCode: 0 });
    await handle.exited;
  });

  it("its handle resolves with a reported non-zero exit and logs fixed fields only", async () => {
    const h = nativeHarness();
    h.sessions.set("run-1", true);
    const handle = await h.launcher.launch(h.input());
    h.exits.set("run-1", 137);
    expect(await handle.exited).toBe(137);
    expect(substrateWarn).toHaveBeenCalledTimes(1);
    expect(substrateWarn.mock.calls[0][0]).toEqual({ runId: "run-1", code: 137, stderrTailOmitted: "not_available" });
    expect(JSON.stringify(substrateWarn.mock.calls)).not.toContain(FAKE_NATIVE_CAP);
  });

  it("rejects with a fixed code when the recorded exit cannot be read", async () => {
    const h = nativeHarness({
      launcher: {
        workerExits: {
          exitCode: async () => {
            throw new Error("prisma says " + FAKE_NATIVE_CAP);
          },
        },
      },
    });
    await h.api.ensureActorTemplate(nativeTemplate(h.config));
    await h.api.createActor(h.config.atespace, h.actor, nativeTemplate(h.config).name);
    const err = (await h.launcher.inspect("run-1").catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("native_sandbox_substrate_failed: workerExit: unexpected");
    expect(err.cause).toBeUndefined();
  });

  it("rejects with a fixed code when the actor cannot be read", async () => {
    const h = nativeHarness();
    h.api.failNext("getActor", new SubstrateUnavailableError("quoting " + FAKE_NATIVE_CAP));
    await expect(h.launcher.inspect("run-1")).rejects.toThrow(
      /^native_sandbox_substrate_failed: getActor: substrate_unavailable$/,
    );
  });

  it("its handle resolves on a crash and logs fixed fields only", async () => {
    const h = nativeHarness();
    h.sessions.set("run-1", true);
    const handle = await h.launcher.launch(h.input());
    // A failed poll is retried.
    h.api.failNext("getActor", new SubstrateUnavailableError("x"));
    h.api.setState(h.config.atespace, h.actor, "CRASHED");
    expect(await handle.exited).toBe(1);
    expect(substrateWarn).toHaveBeenCalledTimes(1);
    expect(substrateWarn.mock.calls[0][0]).toEqual({ runId: "run-1", code: 1, stderrTailOmitted: "not_available" });
  });

  it("its handle resolves 0 once the session ends, and logs nothing", async () => {
    const h = nativeHarness();
    h.sessions.set("run-1", true);
    const handle = await h.launcher.launch(h.input());
    h.sessions.set("run-1", false);
    expect(await handle.exited).toBe(0);
    expect(substrateWarn).not.toHaveBeenCalled();
  });

  it("its handle resolves null when the actor is gone, and kill deletes it", async () => {
    const h = nativeHarness();
    h.sessions.set("run-1", true);
    const handle = await h.launcher.launch(h.input());
    handle.kill();
    expect(await handle.exited).toBeNull();
    expect(h.api.actors.has(h.actorKey)).toBe(false);
    expect(h.api.egressPolicies.has(h.actorKey)).toBe(false);
    // handle(runId) attaches the same way.
    expect(await h.launcher.handle("run-1").exited).toBeNull();
  });

  it("removes the policy, the actor and the Secret, idempotently", async () => {
    const h = nativeHarness();
    await h.launcher.launch(h.input());
    await h.launcher.remove("run-1");
    await h.launcher.remove("run-1");
    expectNothingLeft(h);

    const failing = nativeHarness();
    await failing.launcher.launch(failing.input());
    failing.api.failNext("deleteActor", new SubstrateUnavailableError("quoting " + FAKE_NATIVE_CAP));
    const err = (await failing.launcher.remove("run-1").catch((e: unknown) => e)) as Error;
    // remove rejects, so the executor leaves workerRemovedAt null and the sweep retries (Task 6).
    expect(err.message).toBe("native_sandbox_substrate_failed: deleteActor: substrate_unavailable");
    expect(err.message).not.toContain(FAKE_NATIVE_CAP);
    // Policy first: an actor with no policy is offline (Substrate's egress is default-deny).
    expect(failing.api.egressPolicies.has(failing.actorKey)).toBe(false);
    expect(failing.api.actors.has(failing.actorKey)).toBe(true);
    // The Secret goes even though the actor did not.
    expect(failing.secrets.secrets.has(failing.secretKey)).toBe(false);
    expect(failing.failures).toEqual([
      { runId: "run-1", substrateCall: "deleteActor", errorCode: "substrate_unavailable" },
    ]);
    // The sweep's retry finishes the job.
    await failing.launcher.remove("run-1");
    expectNothingLeft(failing);
  });

  it("rejects a failed kill with a fixed code and reports it", async () => {
    const h = nativeHarness();
    h.api.failNext("deleteActor", new SubstrateUnavailableError("quoting " + FAKE_NATIVE_CAP));
    await expect(h.launcher.kill("run-1")).rejects.toThrow(
      /^native_sandbox_substrate_failed: deleteActor: substrate_unavailable$/,
    );
    expect(h.failures).toEqual([{ runId: "run-1", substrateCall: "deleteActor", errorCode: "substrate_unavailable" }]);
  });

  it("rejects with a fixed code when the session cannot be read", async () => {
    const h = nativeHarness({
      launcher: {
        sessionActive: async () => {
          throw new Error("prisma says " + FAKE_NATIVE_CAP);
        },
      },
    });
    await h.api.ensureActorTemplate(nativeTemplate(h.config));
    await h.api.createActor(h.config.atespace, h.actor, nativeTemplate(h.config).name);
    const err = (await h.launcher.inspect("run-1").catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("native_sandbox_substrate_failed: sessionActive: unexpected");
    expect(err.cause).toBeUndefined();
  });

  it("start ensures the template in the background, and launch waits for it", async () => {
    const h = nativeHarness();
    const gate = deferred();
    let held = true;
    h.api.before.ensureActorTemplate = async () => {
      if (held) {
        held = false;
        await gate.promise;
      }
    };
    await h.launcher.start();
    expect(h.order).toEqual(["ensureActorTemplate"]);
    const launched = h.launcher.launch(h.input());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.order).not.toContain("createActor");
    gate.resolve();
    await launched;
    expect(h.order.indexOf("createActor")).toBeGreaterThan(h.order.indexOf("getActorTemplate"));
    expect(h.api.actors.get(h.actorKey)?.state).toBe("RUNNING");
  });

  it("logs a failed background ensure with fixed fields only", async () => {
    const h = nativeHarness();
    h.api.failNext("ensureActorTemplate", new Error("quoting " + FAKE_NATIVE_CAP));
    await h.launcher.start();
    await vi.waitFor(() => expect(substrateWarn).toHaveBeenCalled());
    expect(substrateWarn.mock.calls[0][0]).toEqual({ substrateCall: "ensureActorTemplate", errorCode: "unexpected" });
    expect(JSON.stringify(substrateWarn.mock.calls)).not.toContain(FAKE_NATIVE_CAP);
    // A launch after it ensures the template itself.
    await h.launcher.launch(h.input());
    expect(h.api.actors.get(h.actorKey)?.state).toBe("RUNNING");
  });

  it("lists no workers, so the executor sweeps from rows", async () => {
    const h = nativeHarness();
    expect(h.launcher.listsWorkers).toBe(false);
    expect(await h.launcher.listWorkers()).toEqual([]);
    await expect(h.launcher.removeByWorkerName("x")).resolves.toBeUndefined();
    expect(h.order).toEqual([]);
  });
});

describe("SubstrateNativeWorkerLauncher startup canary", () => {
  const UNENFORCED = (reason: string) =>
    `native_sandbox_network_unenforced: the Substrate egress policy could not be proven for this worker template (${reason}).`;
  const canaryActors = (h: ReturnType<typeof nativeHarness>) => [
    ...new Set(h.api.canaryCalls.filter((c) => c.method === "createActor").map((c) => c.args[1] as string)),
  ];

  it("proves the template once, then launches runs", async () => {
    const h = nativeHarness();
    await h.launcher.start();
    await h.launcher.launch(h.input());
    const [actor] = canaryActors(h);
    expect(actor).toMatch(/^wr-[0-9a-f]{20}-canary$/);
    const create = h.api.canaryCalls.find((c) => c.method === "createActor");
    expect(create?.args).toEqual([NATIVE_CONFIG.atespace, actor, nativeTemplate(NATIVE_CONFIG).name]);
    const policy = h.api.canaryCalls.find((c) => c.method === "putEgressPolicy");
    expect(policy?.args).toEqual([NATIVE_CONFIG.atespace, actor, nativeCanaryEgress(actor, NATIVE_CONFIG)]);
    // Its own Secret, made before its actor and deleted after it.
    expect(h.secrets.canaryCalls).toEqual([
      `create ${NATIVE_CONFIG.credentialsNamespace}/${actor}`,
      `delete ${NATIVE_CONFIG.credentialsNamespace}/${actor}`,
    ]);
    expect(h.secrets.canarySecrets.size).toBe(0);
    expect(h.api.canaryCalls.map((c) => c.method)).toEqual([
      "createActor",
      "putEgressPolicy",
      "resumeActor",
      "deleteEgressPolicy",
      "deleteActor",
    ]);
    // Deleted with its policy and its row.
    expect(h.api.actors.has(`${NATIVE_CONFIG.atespace}/${actor}`)).toBe(false);
    expect(h.api.egressPolicies.has(`${NATIVE_CONFIG.atespace}/${actor}`)).toBe(false);
    expect((h.canaries as MemoryNativeCanaryStore).rows.size).toBe(0);
    // The run itself launched as usual.
    expect(h.api.actors.get(h.actorKey)?.state).toBe("RUNNING");
    // A second launch makes no second canary.
    await h.launcher.launch(h.input({ runId: "run-2" }));
    expect(canaryActors(h)).toHaveLength(1);
  });

  it("runs the canary on the first launch when start was not called, before the run's Secret", async () => {
    const h = nativeHarness();
    h.api.canaryBefore.createActor = async () => {
      expect(h.secrets.calls).toEqual([]);
    };
    await h.launcher.launch(h.input());
    expect(canaryActors(h)).toHaveLength(1);
    expect(h.api.actors.get(h.actorKey)?.state).toBe("RUNNING");
  });

  it.each([
    ["deny_port_reachable", { canaryVerdict: "deny_port_reachable" as const }],
    ["outside_reachable", { canaryVerdict: "outside_reachable" as const }],
  ])("refuses every launch after a %s canary, with no second canary", async (reason, options) => {
    const h = nativeHarness(options);
    await expect(h.launcher.launch(h.input())).rejects.toThrow(UNENFORCED(reason));
    expect(h.secrets.calls).toEqual([]);
    // The verdict is final: the next launch is refused the same way, and no canary runs again.
    h.harness.canaryVerdict = "pass";
    const err = (await h.launcher.launch(h.input({ runId: "run-2" })).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe(UNENFORCED(reason));
    expect(h.secrets.calls).toEqual([]);
    expect(canaryActors(h)).toHaveLength(1);
    expect(h.api.actors.size).toBe(0);
    // The canary's one log line: the template and the result.
    expect(substrateWarn).toHaveBeenCalledWith(
      { template: nativeTemplate(NATIVE_CONFIG).name, result: reason },
      "native substrate canary",
    );
  });

  it.each([
    ["gateway_unreachable", { canaryVerdict: "gateway_unreachable" as const }],
    ["canary_timeout", { canaryVerdict: "silent" as const, launcher: { canaryTimeoutMs: 5_000 } }],
  ])("refuses the launch after a %s canary, and the next launch runs a new one", async (reason, options) => {
    const h = nativeHarness(options);
    await expect(h.launcher.launch(h.input())).rejects.toThrow(UNENFORCED(reason));
    expect(h.secrets.calls).toEqual([]);
    expect(substrateWarn).toHaveBeenCalledWith(
      { template: nativeTemplate(NATIVE_CONFIG).name, result: reason },
      "native substrate canary",
    );
    // Says nothing about the policy (the gateway was down or slow): tried again, not kept.
    h.harness.canaryVerdict = "pass";
    await h.launcher.launch(h.input({ runId: "run-2" }));
    expect(canaryActors(h)).toHaveLength(2);
    expect(h.api.actors.get(`${NATIVE_CONFIG.atespace}/${nativeActorName(substrateRunToken("run-2"))}`)?.state).toBe(
      "RUNNING",
    );
  });

  it("keeps a real isolation failure even after a retryable outcome", async () => {
    const h = nativeHarness({ canaryVerdict: "gateway_unreachable" });
    await expect(h.launcher.launch(h.input())).rejects.toThrow(UNENFORCED("gateway_unreachable"));
    h.harness.canaryVerdict = "deny_port_reachable";
    await expect(h.launcher.launch(h.input())).rejects.toThrow(UNENFORCED("deny_port_reachable"));
    h.harness.canaryVerdict = "pass";
    await expect(h.launcher.launch(h.input())).rejects.toThrow(UNENFORCED("deny_port_reachable"));
    expect(canaryActors(h)).toHaveLength(2);
    expect(h.secrets.calls).toEqual([]);
  });

  it("under low-power mode, start runs no canary, and a launch wakes the gateway before its canary", async () => {
    const events: string[] = [];
    let awake = false;
    const ensureAwake = vi.fn(async () => {
      events.push("ensureAwake");
      awake = true;
    });
    const h = nativeHarness({ power: fakePower(ensureAwake) });
    // An asleep gateway: the canary could not reach it.
    h.api.onCanaryResumed = async (actor) => {
      await h.reportAs(actor, awake ? "pass" : "gateway_unreachable");
    };
    h.api.canaryBefore.createActor = async () => void events.push("canary");
    await h.launcher.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.api.canaryCalls).toEqual([]);
    expect(ensureAwake).not.toHaveBeenCalled();
    await h.launcher.launch(h.input());
    expect(events).toEqual(["ensureAwake", "canary"]);
    expect(h.api.actors.get(h.actorKey)?.state).toBe("RUNNING");
  });

  it("sweeps a canary left by a crashed process (its actor, policy and row) before a new one", async () => {
    const h = nativeHarness();
    const store = h.canaries as MemoryNativeCanaryStore;
    const stale = "wr-00000000000000000000-canary";
    const fresh = "wr-11111111111111111111-canary";
    await h.api.ensureActorTemplate(nativeTemplate(NATIVE_CONFIG));
    for (const actor of [stale, fresh]) {
      await h.api.createActor(NATIVE_CONFIG.atespace, actor, nativeTemplate(NATIVE_CONFIG).name);
      await h.api.putEgressPolicy(NATIVE_CONFIG.atespace, actor, nativeCanaryEgress(actor, NATIVE_CONFIG));
    }
    // The stale row is older than any canary can run; the fresh one may be another replica's.
    store.rows.set(stale, { template: "wardby-native-0123456789abcdef", createdAt: new Date(0) });
    store.rows.set(fresh, { template: "wardby-native-0123456789abcdef", createdAt: new Date(h.now()) });
    await h.launcher.launch(h.input());
    expect(h.api.actors.has(`${NATIVE_CONFIG.atespace}/${stale}`)).toBe(false);
    expect(h.api.egressPolicies.has(`${NATIVE_CONFIG.atespace}/${stale}`)).toBe(false);
    expect(h.secrets.canaryCalls).toContain(`delete ${NATIVE_CONFIG.credentialsNamespace}/${stale}`);
    expect(h.secrets.canaryCalls).not.toContain(`delete ${NATIVE_CONFIG.credentialsNamespace}/${fresh}`);
    expect(store.rows.has(stale)).toBe(false);
    expect(h.api.actors.has(`${NATIVE_CONFIG.atespace}/${fresh}`)).toBe(true);
    expect(store.rows.has(fresh)).toBe(true);
    expect(h.api.actors.get(h.actorKey)?.state).toBe("RUNNING");
  });

  it("keeps a stale row whose actor cannot be deleted, for a later sweep", async () => {
    const h = nativeHarness();
    const store = h.canaries as MemoryNativeCanaryStore;
    const stale = "wr-00000000000000000000-canary";
    store.rows.set(stale, { template: "wardby-native-0123456789abcdef", createdAt: new Date(0) });
    failNextCanary(h.api, "deleteActor", new SubstrateUnavailableError("quoting " + FAKE_NATIVE_CAP));
    await h.launcher.launch(h.input());
    expect(store.rows.has(stale)).toBe(true);
    expect(JSON.stringify(substrateWarn.mock.calls)).not.toContain(FAKE_NATIVE_CAP);
  });

  it("keeps the canary's row when its actor cannot be deleted, so the sweep finds it", async () => {
    const h = nativeHarness();
    const store = h.canaries as MemoryNativeCanaryStore;
    let actor = "";
    h.api.canaryBefore.deleteActor = async (_atespace, name) => {
      actor = name as string;
      throw new SubstrateUnavailableError("down");
    };
    await h.launcher.launch(h.input());
    expect(actor).toMatch(/-canary$/);
    expect(store.rows.has(actor)).toBe(true);
  });

  it("waits a second between reads of the verdict, up to canaryTimeoutMs", async () => {
    const h = nativeHarness({ canaryVerdict: "silent", launcher: { canaryTimeoutMs: 3_000 } });
    await expect(h.launcher.launch(h.input())).rejects.toThrow(UNENFORCED("canary_timeout"));
    expect(h.sleeps).toEqual([1_000, 1_000, 1_000]);
  });

  it("retries the canary after a failed call", async () => {
    const h = nativeHarness();
    failNextCanary(h.api, "createActor", new SubstrateUnavailableError("quoting " + FAKE_NATIVE_CAP));
    const err = (await h.launcher.launch(h.input()).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe(UNENFORCED("createActor_failed"));
    expect(h.secrets.calls).toEqual([]);
    await h.launcher.launch(h.input());
    expect(canaryActors(h)).toHaveLength(2);
    expect(h.api.actors.get(h.actorKey)?.state).toBe("RUNNING");
    expect(JSON.stringify(substrateWarn.mock.calls)).not.toContain(FAKE_NATIVE_CAP);
  });

  it("refuses for room when the canary finds none, and tries again next launch", async () => {
    const h = nativeHarness({ goldenWaitMs: 0 });
    failNextCanary(h.api, "resumeActor", () => new SubstrateExhaustedError("no room"));
    await expect(h.launcher.launch(h.input())).rejects.toThrow(CAPACITY);
    expect(h.secrets.calls).toEqual([]);
    await h.launcher.launch(h.input());
    expect(canaryActors(h)).toHaveLength(2);
  });

  it("gives the canary its own capability only in its Secret: never the run's, never in a policy or log", async () => {
    const h = nativeHarness();
    let capability = "";
    let rowHash: string | undefined;
    h.api.canaryBefore.resumeActor = async (_atespace, actor) => {
      capability = h.secrets.canaryCapability(actor as string) ?? "";
      rowHash = (h.canaries as MemoryNativeCanaryStore).rows.get(actor as string)?.capabilityHash;
    };
    await h.launcher.launch(h.input());
    expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The row keeps only the hash.
    expect(rowHash).toBe(canaryCapabilityHash(capability));
    const canary = JSON.stringify([h.api.canaryCalls, nativeTemplate(NATIVE_CONFIG)]);
    expect(canary).not.toContain(capability);
    expect(canary).not.toContain(FAKE_NATIVE_CAP);
    expect(JSON.stringify([...h.secrets.secrets.values()])).not.toContain(capability);
    expect(substrateInfo).toHaveBeenCalledWith(
      { template: nativeTemplate(NATIVE_CONFIG).name, result: "pass" },
      "native substrate canary",
    );
    const logged = JSON.stringify([substrateWarn.mock.calls, substrateInfo.mock.calls, h.failures]);
    expect(logged).not.toContain(capability);
  });

  it("takes no verdict without the canary's capability, and a used capability counts once", async () => {
    const h = nativeHarness({ canaryVerdict: "silent", launcher: { canaryTimeoutMs: 3_000 } });
    const store = h.canaries as MemoryNativeCanaryStore;
    h.api.onCanaryResumed = async (actor) => {
      // A caller without the capability: refused. Then the canary's own report, then a replay.
      expect(await store.report(actor, canaryCapabilityHash("fake_guess_0001"), "pass", new Date())).toBe(false);
      expect(await h.reportAs(actor, "outside_reachable")).toBe(true);
      expect(await h.reportAs(actor, "pass")).toBe(false);
    };
    await expect(h.launcher.launch(h.input())).rejects.toThrow(UNENFORCED("outside_reachable"));
  });

  it("keeps the canary's row when its Secret cannot be deleted, and the sweep deletes the Secret", async () => {
    const h = nativeHarness();
    const store = h.canaries as MemoryNativeCanaryStore;
    h.secrets.canaryBefore.deleteSecret = async () => {
      throw new Error("quoting " + FAKE_NATIVE_CAP);
    };
    await h.launcher.launch(h.input());
    const [actor] = canaryActors(h);
    expect(store.rows.has(actor)).toBe(true);
    expect(h.secrets.canarySecrets.has(actor)).toBe(true);
    // Much later, the next process's canary sweeps the row and deletes its Secret.
    store.rows.get(actor)!.createdAt = new Date(0);
    const next = nativeHarness({ canaries: store });
    next.secrets.canarySecrets.set(actor, h.secrets.canarySecrets.get(actor)!);
    await next.launcher.launch(next.input({ runId: "run-2" }));
    expect(next.secrets.canaryCalls).toContain(`delete ${NATIVE_CONFIG.credentialsNamespace}/${actor}`);
    expect(next.secrets.canarySecrets.has(actor)).toBe(false);
    expect(store.rows.has(actor)).toBe(false);
  });

  it("refuses the launch with createSecret_failed when the canary's Secret cannot be made, and deletes its row", async () => {
    const h = nativeHarness();
    h.secrets.canaryBefore.createSecret = async () => {
      throw new Error("quoting " + FAKE_NATIVE_CAP);
    };
    await expect(h.launcher.launch(h.input())).rejects.toThrow(UNENFORCED("createSecret_failed"));
    expect(h.api.canaryCalls).toEqual([]);
    expect((h.canaries as MemoryNativeCanaryStore).rows.size).toBe(0);
    expect(h.secrets.calls).toEqual([]);
    expect(JSON.stringify(substrateWarn.mock.calls)).not.toContain(FAKE_NATIVE_CAP);
  });
});
