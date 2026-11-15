// Warm rounds (SUBSTRATE_WARM_ROUNDS, experimental): retain() parks, a continuation (JobSpec.warm) adopts.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { logger, setLogLineFilter } from "../../../core/logger.js";
import { warmFingerprint } from "../warm-fingerprint.js";
import { JobCapacityError, type JobHandle, type JobRetention, type JobSpec } from "../types.js";
import {
  allBlobs,
  CONFIG,
  FAKE_CAP,
  FAKE_MCP,
  FAKE_MCP_2,
  makeHarness,
  TOOL_IMAGE,
  type Harness,
} from "./launcher.test-support.js";
import type { Room } from "./placement.js";
import { SubstrateJobLauncher, type WarmRoundsOptions } from "./launcher.js";
import {
  BLOB,
  REPO_BLOB,
  agentActorName,
  retiredRunToken,
  roundBlob,
  substrateRunToken,
  toolActorName,
} from "./names.js";
import { agentEgress, agentTemplate, toolTemplate, WARM_ROUNDS_ENV } from "./specs.js";

const WARM: WarmRoundsOptions = { parkTtlMs: 3_600_000, parkMax: 10 };
const SHA_1 = "1".repeat(40);
const SHA_2 = "2".repeat(40);
const FP = "f".repeat(64);
/** What the executor retains a delivered round with: the commit it pushed, the agent's fingerprint. */
const RETAIN: JobRetention = { headSha: SHA_1, fingerprint: FP };
const CAP_2 = "rrp_fake_capability_value_000002";
const CAP_3 = "rrp_fake_capability_value_000003";
const CAPS: Record<string, string> = { "run-1": FAKE_CAP, "run-2": CAP_2, "run-3": CAP_3 };
const FAKE_MCP_3 = "rmt_FAKE_MCP_TOKEN_NOT_REAL_" + "3".repeat(19);
/** Each run's MCP token (asked only for a spec with mcpTools). */
const MCPS: Record<string, string | undefined> = { "run-1": FAKE_MCP, "run-2": FAKE_MCP_2, "run-3": FAKE_MCP_3 };
const MODEL = "claude-sonnet-5";

async function warmHarness(
  options: {
    warmRounds?: WarmRoundsOptions;
    workers?: number;
    workerSize?: Room;
    suspendedHoldRoom?: boolean;
    mcpTokenFor?: (runId: string) => string | undefined;
  } = {},
): Promise<Harness> {
  const h = await makeHarness({
    warmRounds: options.warmRounds ?? WARM,
    ...(options.workers !== undefined ? { workers: options.workers } : {}),
    ...(options.workerSize ? { workerSize: options.workerSize } : {}),
    ...(options.suspendedHoldRoom ? { suspendedHoldRoom: true } : {}),
    capabilityFor: (runId) => CAPS[runId] ?? FAKE_CAP,
    mcpTokenFor: options.mcpTokenFor ?? ((runId) => MCPS[runId]),
  });
  await writeFile(h.spec.inputArtifact, JSON.stringify({ schemaVersion: 1, runId: "run-1", model: MODEL, task: "1" }));
  return h;
}

/** Another run's spec: its own input and workspace, continuing nothing. */
async function otherRun(h: Harness, runId: string): Promise<JobSpec> {
  await mkdir(join(h.workspaceRoot, runId, "workspace"), { recursive: true });
  await writeFile(join(h.workspaceRoot, runId, "workspace", "README.md"), "# hello\n");
  const inputArtifact = join(h.root, `input-${runId}.json`);
  await writeFile(inputArtifact, JSON.stringify({ schemaVersion: 1, runId, model: MODEL, task: `task of ${runId}` }));
  return { ...h.spec, runId, inputArtifact };
}

/**
 * A follow-up run's spec: its own input and workspace, continuing `from` (default run-1) on the
 * branch head `headSha` with the agent fingerprint `fingerprint` (default: what run-1 was retained with).
 */
async function followUp(
  h: Harness,
  runId: string,
  warm: { from?: string; headSha?: string; fingerprint?: string } = {},
): Promise<JobSpec> {
  const spec = await otherRun(h, runId);
  await writeFile(
    spec.inputArtifact,
    JSON.stringify({
      schemaVersion: 1,
      runId,
      model: MODEL,
      task: `task of ${runId}`,
      continuationOf: { runId: "run-1" },
    }),
  );
  return {
    ...spec,
    warm: { fromRunId: warm.from ?? "run-1", headSha: warm.headSha ?? SHA_1, fingerprint: warm.fingerprint ?? FP },
  };
}

const EXTRAS = [
  { name: "extra-alpha", access: "write" as const },
  { name: "extra-beta", access: "read" as const },
];

/** `spec` with EXTRAS as its extra repositories, each folder prepared as makeHarness does. */
async function withExtras(h: Harness, spec: JobSpec): Promise<JobSpec> {
  const repositories = [];
  for (const { name, access } of EXTRAS) {
    const hostPath = join(h.workspaceRoot, spec.runId, "repos", name, "workspace");
    await mkdir(hostPath, { recursive: true });
    await writeFile(join(hostPath, "README.md"), `# ${name}\n`);
    repositories.push({ name, access, hostPath });
  }
  return { ...spec, repositories };
}

/** What the proxy writes when a round's worker and tool finish: result-n and done-n. */
async function finishRound(h: Harness, token: string, runId: string, round: number): Promise<void> {
  const output = { ...h.output, runId };
  await h.blobs.put(BLOB.result(token, round), Buffer.from(JSON.stringify(output)));
  await h.blobs.put(BLOB.workspace(token, round), Buffer.from("tar"));
  await h.blobs.put(BLOB.done(token, round), Buffer.from('{"workspace":"ok"}'));
}

function actorStates(h: Harness, token: string): string[] {
  return [agentActorName(token), toolActorName(token)].map((name) => h.api.actors.get(`wardby-runs/${name}`)!.state);
}

async function parkedRoundOne(h: Harness, retention: JobRetention = RETAIN): Promise<JobHandle> {
  const handle = await h.launcher.launch(h.spec);
  await finishRound(h, h.token, "run-1", 1);
  expect((await h.launcher.status(handle)).state).toBe("succeeded");
  expect(await h.launcher.retain(handle, retention)).toBe(true);
  return handle;
}

/** A launcher on the same store, blobs, API and Secrets: the control plane after a restart (null: warm rounds off). */
function restartedLauncher(h: Harness, warmRounds: WarmRoundsOptions | null = WARM): SubstrateJobLauncher {
  return new SubstrateJobLauncher({
    api: h.api,
    runs: h.runs,
    blobs: h.blobs,
    secrets: h.secrets,
    relay: h.relay,
    bridgeToolImages: [TOOL_IMAGE],
    config: CONFIG,
    workspaceRoot: h.workspaceRoot,
    resolveCapability: async (runId) => CAPS[runId] ?? FAKE_CAP,
    resolveMcpToken: async (runId) => MCPS[runId],
    now: () => 1_000_000,
    ...(warmRounds ? { warmRounds, onWarmEvent: (event) => h.warmEvents.push(event) } : {}),
  });
}

const secretKey = (h: Harness) => `${CONFIG.credentialsNamespace}/${h.token}`;

describe("SubstrateJobLauncher without warm rounds", () => {
  it("keeps today's handle, templates and removal; retain() removes and warmOutcome() knows nothing", async () => {
    const h = await makeHarness();
    expect(h.launcher.plannedHandle(h.spec)).toEqual({ backend: "substrate", id: `wardby-runs/${h.token}` });
    const handle = await h.launcher.launch(h.spec);
    expect(handle.id).toBe(`wardby-runs/${h.token}`);
    for (const template of h.api.templates.values()) {
      expect(template.containers[0].env!.map((e) => e.name)).toEqual(["WARDBY_PROXY_URL"]);
    }
    await finishRound(h, h.token, "run-1", 1);
    expect(await h.launcher.retain(handle, RETAIN)).toBe(false);
    expect(h.api.actors.size).toBe(0);
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect(h.secrets.secrets.size).toBe(0);
    expect(await h.launcher.warmOutcome(handle)).toBeUndefined();
  });

  it("ignores a continuation's warm hint", async () => {
    const h = await makeHarness();
    const spec = { ...h.spec, warm: { fromRunId: "run-0", headSha: SHA_1, fingerprint: FP } };
    const handle = await h.launcher.launch(spec);
    expect(handle.id).toBe(`wardby-runs/${h.token}`);
    expect((await h.runs.get("run-1"))!.coldReason).toBeUndefined();
    expect(await h.launcher.warmOutcome(handle)).toBeUndefined();
  });
});

describe("SubstrateJobLauncher with warm rounds", () => {
  it("never adopts for a spec with repositories, and leaves the park alone", async () => {
    const h = await warmHarness();
    await parkedRoundOne(h);
    h.warmEvents.length = 0;
    const spec = await withExtras(h, await followUp(h, "run-2"));
    const handle = await h.launcher.launch(spec);
    const row = await h.runs.get("run-2");
    expect(row?.token).toBe(substrateRunToken("run-2"));
    expect(row?.round).toBe(1);
    expect(row).not.toHaveProperty("coldReason");
    expect(row?.repositories).toEqual(EXTRAS);
    expect(await h.launcher.warmOutcome(handle)).toBeUndefined();
    expect(h.warmEvents.map((event) => event.event)).not.toContain("substrate_warm_not_adopted");
    expect(h.warmEvents.map((event) => event.event)).not.toContain("substrate_warm_adopted");
    expect((await h.runs.get("run-1"))?.phase).toBe("parked");
    expect(actorStates(h, h.token)).toEqual(["SUSPENDED", "SUSPENDED"]);
  });

  it("retain removes a run with repositories", async () => {
    const h = await warmHarness();
    const spec = await withExtras(h, h.spec);
    const handle = await h.launcher.launch(spec);
    await finishRound(h, h.token, "run-1", 1);
    await h.blobs.put(REPO_BLOB.workspace(h.token, "extra-alpha"), Buffer.from("tar"));
    expect((await h.launcher.status(handle)).state).toBe("succeeded");
    const suspended: string[] = [];
    h.api.suspendActor = async (_atespace, name) => {
      suspended.push(name);
    };
    expect(await h.launcher.retain(handle, RETAIN)).toBe(false);
    expect(suspended).toEqual([]);
    expect((await h.runs.get("run-1"))?.phase).toBe("removed");
    expect(await h.runs.countParked()).toBe(0);
    expect(h.api.actors.size).toBe(0);
    for (const key of (await allBlobs(h)).keys()) expect(key).not.toContain(h.token);
  });

  it("gives the bridges the warm-rounds switch through the templates (their own templates)", async () => {
    const h = await warmHarness();
    // Plannable again: `<atespace>/<runId>`, the same handle launch() returns.
    expect(h.launcher.plannedHandle(h.spec)).toEqual({ backend: "substrate", id: "wardby-runs/run-1" });
    const handle = await h.launcher.launch(h.spec);
    expect(handle).toEqual(h.launcher.plannedHandle(h.spec));
    for (const template of h.api.templates.values()) {
      expect(template.containers[0].env).toContainEqual({ name: WARM_ROUNDS_ENV, value: "1" });
    }
    expect(agentTemplate(h.spec, CONFIG).name).not.toBe(agentTemplate(h.spec, { ...CONFIG, warmRounds: true }).name);
    expect(toolTemplate(h.spec, CONFIG).name).not.toBe(toolTemplate(h.spec, { ...CONFIG, warmRounds: true }).name);
    // A run that continues nothing has no warm outcome.
    expect(await h.launcher.warmOutcome(handle)).toBeUndefined();
  });

  it("says whether warm rounds are on (WorkspaceJobLauncher.warmRounds), from its configuration", async () => {
    const h = await warmHarness();
    expect(h.launcher.warmRounds).toBe(true);
    expect(restartedLauncher(h).warmRounds).toBe(true);
    // Off: the launcher still implements retain, but the executor must take the plain path.
    expect(restartedLauncher(h, null).warmRounds).toBe(false);
    expect(typeof restartedLauncher(h, null).retain).toBe("function");
  });

  it("refuses a malformed warm hint (no planned handle, the launch rejects)", async () => {
    const h = await warmHarness();
    for (const warm of [
      { fromRunId: "run-0", headSha: "not-a-sha", fingerprint: FP },
      { fromRunId: "run-0", headSha: SHA_1, fingerprint: "F".repeat(64) },
      { fromRunId: "../x", headSha: SHA_1, fingerprint: FP },
    ]) {
      expect(h.launcher.plannedHandle({ ...h.spec, warm })).toBeUndefined();
      await expect(h.launcher.launch({ ...h.spec, warm })).rejects.toThrow("substrate_spec_invalid");
    }
  });

  it("retain() parks a succeeded run: actors suspended, Secret and tool setup gone, relay purged, still succeeded", async () => {
    const h = await warmHarness();
    const handle = await h.launcher.launch(h.spec);
    const channel = await h.relay.openChannel(h.token);
    await h.relay.fromAgent(h.token, channel, 1, '{"jsonrpc":"2.0","method":"tool"}');
    await finishRound(h, h.token, "run-1", 1);
    expect(await h.launcher.retain(handle, RETAIN)).toBe(true);
    const record = await h.runs.get("run-1");
    expect(record).toMatchObject({
      phase: "parked",
      headSha: SHA_1,
      fingerprint: FP,
      parkedAt: new Date(1_000_000),
      round: 1,
      deadlineAt: new Date(1_000_000 + WARM.parkTtlMs),
    });
    expect(actorStates(h, h.token)).toEqual(["SUSPENDED", "SUSPENDED"]);
    expect(h.api.egressPolicies.size).toBe(2);
    // No live credential at rest: the Secret and the registry token's only home are gone.
    expect(h.secrets.secrets.has(secretKey(h))).toBe(false);
    expect(await h.blobs.head(BLOB.toolSetup(h.token))).toBeNull();
    expect(h.relay.hasRelayRows(h.token)).toBe(false);
    expect(await h.blobs.head(BLOB.seed(h.token))).toBeNull();
    expect(await h.blobs.head(BLOB.workspace(h.token))).toBeNull();
    expect(await h.blobs.head(BLOB.result(h.token))).not.toBeNull();
    const result = await h.launcher.collect(handle);
    expect(result).toMatchObject({ exitCode: 0, reason: "completed" });
    expect(JSON.parse(result.resultArtifact!)).toMatchObject({ runId: "run-1" });
    expect(h.warmEvents).toEqual([
      { event: "substrate_warm_parked", runId: "run-1", runToken: h.token, round: 1, ms: expect.any(Number) },
    ]);
    // A retried retain() with the same retention is answered again; nothing changes.
    expect(await h.launcher.retain(handle, RETAIN)).toBe(true);
    expect((await h.runs.get("run-1"))!.phase).toBe("parked");
  });

  it("remove() always removes, even a succeeded run", async () => {
    const h = await warmHarness();
    const handle = await h.launcher.launch(h.spec);
    await finishRound(h, h.token, "run-1", 1);
    await h.launcher.remove(handle);
    expect(h.api.actors.size).toBe(0);
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect(h.warmEvents).toEqual([]);
  });

  it("retain() removes, and answers false, for a run it cannot keep", async () => {
    // A failed run.
    const failed = await warmHarness();
    const handle = await failed.launcher.launch(failed.spec);
    await failed.blobs.put(BLOB.done(failed.token), Buffer.from('{"workspace":"failed"}'));
    expect(await failed.launcher.retain(handle, RETAIN)).toBe(false);
    expect(failed.api.actors.size).toBe(0);
    expect((await failed.runs.get("run-1"))!.phase).toBe("removed");
    // Parking off (SUBSTRATE_PARK_MAX=0).
    const off = await warmHarness({ warmRounds: { ...WARM, parkMax: 0 } });
    const offHandle = await off.launcher.launch(off.spec);
    await finishRound(off, off.token, "run-1", 1);
    expect(await off.launcher.retain(offHandle, RETAIN)).toBe(false);
    expect((await off.runs.get("run-1"))!.phase).toBe("removed");
    expect(off.api.actors.size).toBe(0);
    // A malformed retention.
    const bad = await warmHarness();
    const badHandle = await bad.launcher.launch(bad.spec);
    await finishRound(bad, bad.token, "run-1", 1);
    expect(await bad.launcher.retain(badHandle, { headSha: "HEAD", fingerprint: FP })).toBe(false);
    expect((await bad.runs.get("run-1"))!.phase).toBe("removed");
    // A run still running: as remove(), refused.
    const live = await warmHarness();
    const liveHandle = await live.launcher.launch(live.spec);
    await expect(live.launcher.retain(liveHandle, RETAIN)).rejects.toThrow("job_not_terminal");
    expect((await live.runs.get("run-1"))!.phase).toBe("running");
    // An unknown handle.
    expect(await live.launcher.retain({ backend: "substrate", id: "wardby-runs/nope" }, RETAIN)).toBe(false);
  });

  it("retain() of a run parked with another retention removes it", async () => {
    const h = await warmHarness();
    const handle = await parkedRoundOne(h);
    expect(await h.launcher.retain(handle, { headSha: SHA_2, fingerprint: FP })).toBe(false);
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect(h.api.actors.size).toBe(0);
  });

  it("retain() removes the run when a park step fails: a suspend, or the Secret's deletion", async () => {
    const h = await warmHarness();
    const handle = await h.launcher.launch(h.spec);
    await finishRound(h, h.token, "run-1", 1);
    h.api.suspendActor = async () => {
      throw new Error("down");
    };
    expect(await h.launcher.retain(handle, RETAIN)).toBe(false);
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect(h.api.actors.size).toBe(0);
    expect(h.warmEvents.map((e) => e.event)).toEqual(["substrate_warm_park_failed"]);
    expect(h.callFailures).toEqual([{ runId: "run-1", substrateCall: "suspendActor", errorCode: "unexpected" }]);

    const s = await warmHarness();
    const second = await s.launcher.launch(s.spec);
    await finishRound(s, s.token, "run-1", 1);
    const deleteSecret = s.secrets.deleteSecret.bind(s.secrets);
    let fail = true;
    s.secrets.deleteSecret = async (namespace, name) => {
      if (fail) {
        fail = false;
        throw new Error("api_down");
      }
      return deleteSecret(namespace, name);
    };
    expect(await s.launcher.retain(second, RETAIN)).toBe(false);
    expect((await s.runs.get("run-1"))!.phase).toBe("removed");
    expect(s.secrets.secrets.size).toBe(0);
  });

  it("removes a parked run in full when remove() is called on it", async () => {
    const h = await warmHarness();
    const handle = await parkedRoundOne(h);
    await h.launcher.remove(handle);
    expect(h.api.actors.size).toBe(0);
    expect(h.api.egressPolicies.size).toBe(0);
    expect(h.secrets.secrets.size).toBe(0);
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect([...(await allBlobs(h)).keys()]).toEqual([]);
  });

  it("adopts the continued run's parked actors: same token, round 2, a fresh Secret with the new capability", async () => {
    const h = await warmHarness();
    const first = await parkedRoundOne(h);
    const spec2 = await followUp(h, "run-2");
    expect(h.launcher.plannedHandle(spec2)).toEqual({ backend: "substrate", id: "wardby-runs/run-2" });
    const before = h.secrets.calls.length;
    const handle = await h.launcher.launch(spec2);
    expect(handle).toEqual(h.launcher.plannedHandle(spec2));
    expect(await h.launcher.warmOutcome(handle)).toEqual({ adopted: true });
    // The rows: run-2 holds run-1's token at round 2; run-1 is adopted under a retired token.
    expect(await h.runs.get("run-2")).toMatchObject({ token: h.token, phase: "running", round: 2 });
    expect((await h.runs.get("run-2"))!.coldReason).toBeUndefined();
    expect(await h.runs.get("run-1")).toMatchObject({ token: retiredRunToken("run-1"), phase: "adopted" });
    // No new actors, no seed: the same two, resumed.
    expect(h.api.actors.size).toBe(2);
    expect(actorStates(h, h.token)).toEqual(["RUNNING", "RUNNING"]);
    expect(await h.blobs.head(BLOB.seed(h.token))).toBeNull();
    expect(JSON.parse((await h.blobs.get(roundBlob(h.token))).toString())).toEqual({ round: 2 });
    expect(JSON.parse((await h.blobs.get(BLOB.input(h.token, 2))).toString())).toMatchObject({ runId: "run-2" });
    expect(await h.blobs.head(BLOB.toolSetup(h.token))).not.toBeNull();
    // The Secret, absent while parked, is created fresh with run-2's capability.
    expect(h.secrets.secrets.get(secretKey(h))!.stringData).toEqual({ capability: CAP_2 });
    expect(h.secrets.calls.slice(before)).toEqual([`delete ${secretKey(h)}`, `create ${secretKey(h)}`]);
    expect(h.warmEvents.at(-1)).toMatchObject({
      event: "substrate_warm_adopted",
      runId: "run-2",
      adoptedRunId: "run-1",
      round: 2,
    });
    expect(Object.keys(h.warmEvents.at(-1)!.steps!)).toEqual(["stage", "secret", "resumeTool", "resumeAgent"]);
    // Round 1's handle names its own (adopted) row: still the succeeded run, and removing it
    // touches nothing of run-2.
    expect((await h.launcher.status(first)).state).toBe("succeeded");
    expect(await h.launcher.warmOutcome(first)).toBeUndefined();
    await h.launcher.remove(first);
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect(actorStates(h, h.token)).toEqual(["RUNNING", "RUNNING"]);
    // A Phase A handle for the token names nothing (it is no longer run-1's own).
    await expect(h.launcher.status({ backend: "substrate", id: `wardby-runs/${h.token}` })).rejects.toThrow(
      "job_not_found",
    );
    // Round 1's files do not count for round 2.
    expect((await h.launcher.status(handle)).state).toBe("running");
    await finishRound(h, h.token, "run-2", 2);
    const result = await h.launcher.collect(handle);
    expect(JSON.parse(result.resultArtifact!)).toMatchObject({ runId: "run-2" });
    // A relaunch of the same spec finds its row and returns the same handle.
    expect(await h.launcher.launch(spec2)).toEqual(handle);
    // After a restart, the outcome is read from the row.
    expect(await restartedLauncher(h).warmOutcome(handle)).toEqual({ adopted: true });
  });

  it("adopts with MCP tools: the fresh Secret holds the new run's MCP token; no policy is re-put", async () => {
    const h = await warmHarness();
    const puts: string[] = [];
    const put = h.api.putEgressPolicy.bind(h.api);
    h.api.putEgressPolicy = async (atespace, actor, rules) => {
      puts.push(actor);
      return put(atespace, actor, rules);
    };
    const handle = await h.launcher.launch({ ...h.spec, mcpTools: true });
    expect(h.secrets.secrets.get(secretKey(h))!.stringData).toEqual({ capability: FAKE_CAP, mcpToken: FAKE_MCP });
    await finishRound(h, h.token, "run-1", 1);
    expect((await h.launcher.status(handle)).state).toBe("succeeded");
    expect(await h.launcher.retain(handle, RETAIN)).toBe(true);
    // Parked: the Secret, MCP token included, is gone.
    expect(h.secrets.secrets.get(secretKey(h))).toBeUndefined();
    const putsBefore = puts.length;
    const spec2 = await followUp(h, "run-2");
    const before = h.secrets.calls.length;
    const second = await h.launcher.launch({ ...spec2, mcpTools: true });
    expect(await h.launcher.warmOutcome(second)).toEqual({ adopted: true });
    expect(h.secrets.secrets.get(secretKey(h))!.stringData).toEqual({ capability: CAP_2, mcpToken: FAKE_MCP_2 });
    expect(h.secrets.calls.slice(before)).toEqual([`delete ${secretKey(h)}`, `create ${secretKey(h)}`]);
    expect(puts.length).toBe(putsBefore);
    // The parked agent's rule, from round 1, still injects the MCP token (from the fresh Secret).
    expect(h.api.egressPolicies.get(`${CONFIG.atespace}/${agentActorName(h.token)}`)).toEqual(
      agentEgress(h.token, CONFIG, { mcp: true }),
    );
    expect(Object.keys(h.warmEvents.at(-1)!.steps!)).toEqual(["stage", "secret", "resumeTool", "resumeAgent"]);
  });

  it("an adopter whose MCP token is invalid fails as on a cold launch", async () => {
    const h = await warmHarness({ mcpTokenFor: (runId) => (runId === "run-2" ? undefined : MCPS[runId]) });
    const handle = await h.launcher.launch({ ...h.spec, mcpTools: true });
    await finishRound(h, h.token, "run-1", 1);
    expect((await h.launcher.status(handle)).state).toBe("succeeded");
    expect(await h.launcher.retain(handle, RETAIN)).toBe(true);
    const spec2 = await followUp(h, "run-2");
    const error = (await h.launcher.launch({ ...spec2, mcpTools: true }).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe("substrate_mcp_token_invalid");
    expect((await h.runs.get("run-2"))!.phase).toBe("provisioning_failed");
    // Every round's resources of the token are gone (the warm state is lost), the Secret included.
    expect(h.api.actors.size).toBe(0);
    expect(h.api.egressPolicies.size).toBe(0);
    expect(h.secrets.secrets.size).toBe(0);
    expect(await h.blobs.head(roundBlob(h.token))).toBeNull();
  });

  it("chains by the continued run: round 2 parks and round 3 adopts it, then a removal deletes every round", async () => {
    const h = await warmHarness();
    await parkedRoundOne(h);
    const second = await h.launcher.launch(await followUp(h, "run-2"));
    await finishRound(h, h.token, "run-2", 2);
    expect(await h.launcher.retain(second, { headSha: SHA_2, fingerprint: FP })).toBe(true);
    expect(await h.runs.get("run-2")).toMatchObject({ phase: "parked", round: 2, headSha: SHA_2 });
    expect(h.secrets.secrets.size).toBe(0);
    // Continuing run-1 (the root) finds nothing parked: run-2 holds the thread's latest round.
    const stale = await h.launcher.launch(await followUp(h, "run-x", { from: "run-1", headSha: SHA_2 }));
    expect(await h.launcher.warmOutcome(stale)).toEqual({ adopted: false, reason: "not_parked" });
    expect((await h.runs.get("run-2"))!.phase).toBe("parked");
    const third = await h.launcher.launch(await followUp(h, "run-3", { from: "run-2", headSha: SHA_2 }));
    expect(third.id).toBe("wardby-runs/run-3");
    expect(await h.runs.get("run-3")).toMatchObject({ token: h.token, round: 3 });
    expect(JSON.parse((await h.blobs.get(roundBlob(h.token))).toString())).toEqual({ round: 3 });
    expect(await h.runs.get("run-2")).toMatchObject({ token: retiredRunToken("run-2"), phase: "adopted" });
    expect(h.secrets.secrets.get(secretKey(h))!.stringData).toEqual({ capability: CAP_3 });
    await h.blobs.put(BLOB.done(h.token, 3), Buffer.from('{"workspace":"failed"}'));
    await h.launcher.remove(third);
    expect([...h.api.actors.keys()].filter((key) => key.includes(h.token))).toEqual([]);
    expect(h.secrets.secrets.has(secretKey(h))).toBe(false);
    for (const key of (await allBlobs(h)).keys()) expect(key).not.toContain(h.token);
  });

  it("on full removal of a chain: purges the relay, and deletes the last round's done, then the round record, last", async () => {
    const h = await warmHarness();
    await parkedRoundOne(h);
    const second = await h.launcher.launch(await followUp(h, "run-2"));
    const channel = await h.relay.openChannel(h.token);
    await h.relay.fromAgent(h.token, channel, 1, '{"jsonrpc":"2.0","method":"tool"}');
    await h.blobs.put(BLOB.done(h.token, 2), Buffer.from('{"workspace":"failed"}'));
    const order: string[] = [];
    const deleteBlob = h.blobs.delete.bind(h.blobs);
    let failResult = true;
    h.blobs.delete = async (key) => {
      order.push(key.split("/").pop()!);
      if (failResult && key === BLOB.result(h.token)) throw new Error("blob_down");
      return deleteBlob(key);
    };
    // A failed outcome deletion leaves round 2's done and the round record: still round 2's outcome.
    await expect(h.launcher.remove(second)).rejects.toThrow("blob_down");
    expect(h.relay.hasRelayRows(h.token)).toBe(false);
    expect(await h.blobs.head(BLOB.done(h.token, 2))).not.toBeNull();
    expect(await h.blobs.head(roundBlob(h.token))).not.toBeNull();
    expect((await h.launcher.status(second)).state).toBe("failed");
    failResult = false;
    order.length = 0;
    await h.launcher.remove(second);
    expect(order.slice(-2)).toEqual(["done-2.json", "round.json"]);
    expect(order.indexOf("done.json")).toBeLessThan(order.indexOf("done-2.json"));
    expect([...(await allBlobs(h)).keys()]).toEqual([]);
    expect((await h.runs.get("run-2"))!.phase).toBe("removed");
  });

  /** Each way a continuation launches cold instead: the reason, on the row and as an event. */
  const refusals: {
    reason: string;
    /** Changes the world after round 1 is parked; returns the continuation's spec. */
    arrange: (h: Harness) => Promise<JobSpec>;
    /** Whether the parked round 1 is removed (it is unless there was nothing parked to remove). */
    removesPark: boolean;
  }[] = [
    {
      reason: "not_parked",
      arrange: (h) => followUp(h, "run-2", { from: "run-0" }),
      removesPark: false,
    },
    {
      reason: "expired",
      arrange: async (h) => {
        // Past the park's expiry but inside the sweep interval, so no sweep removed it first.
        h.setNow(1_000_000 + 10_001);
        return followUp(h, "run-2");
      },
      removesPark: true,
    },
    {
      reason: "branch_moved",
      arrange: (h) => followUp(h, "run-2", { headSha: SHA_2 }),
      removesPark: true,
    },
    {
      reason: "fingerprint_changed",
      arrange: (h) => followUp(h, "run-2", { fingerprint: "e".repeat(64) }),
      removesPark: true,
    },
    {
      reason: "actor_missing",
      arrange: async (h) => {
        h.api.actors.delete(`wardby-runs/${toolActorName(h.token)}`);
        return followUp(h, "run-2");
      },
      removesPark: true,
    },
    {
      reason: "actor_not_suspended",
      arrange: async (h) => {
        h.api.setState("wardby-runs", agentActorName(h.token), "CRASHED");
        return followUp(h, "run-2");
      },
      removesPark: true,
    },
  ];
  for (const { reason, arrange, removesPark } of refusals) {
    it(`launches cold, recording ${reason}, when the continuation cannot adopt`, async () => {
      const h = await warmHarness({ warmRounds: { ...WARM, parkTtlMs: 10_000 } });
      await parkedRoundOne(h);
      const spec2 = await arrange(h);
      const handle = await h.launcher.launch(spec2);
      expect(handle.id).toBe("wardby-runs/run-2");
      expect(await h.runs.get("run-2")).toMatchObject({
        token: substrateRunToken("run-2"),
        round: 1,
        phase: "running",
        coldReason: reason,
      });
      expect(await h.launcher.warmOutcome(handle)).toEqual({ adopted: false, reason });
      expect(await restartedLauncher(h).warmOutcome(handle)).toEqual({ adopted: false, reason });
      expect((await h.runs.get("run-1"))!.phase).toBe(removesPark ? "removed" : "parked");
      if (removesPark) expect(h.api.actors.has(`wardby-runs/${agentActorName(h.token)}`)).toBe(false);
      const event = h.warmEvents.find((e) => e.event === "substrate_warm_not_adopted");
      expect(event).toEqual({
        event: "substrate_warm_not_adopted",
        runId: "run-2",
        adoptedRunId: spec2.warm!.fromRunId,
        reason,
        ...(removesPark ? { runToken: h.token } : {}),
      });
    });
  }

  it("launches cold, recording fingerprint_changed, when only the MCP tool pins differ (fingerprints built by warmFingerprint)", async () => {
    // The launcher compares the two fingerprints it is given; the executor builds them with warmFingerprint.
    const base = {
      agentId: "agent-1",
      provider: "claude-code",
      model: MODEL,
      workerImage: "worker:1",
      toolImage: TOOL_IMAGE,
      cpu: 1,
      memoryMb: 1024,
      diskMb: 1024,
      systemPromptSha256: "c".repeat(64),
      repository: "your-org/your-repo",
      secrets: [],
    };
    const parkedWith = warmFingerprint({ ...base, mcpTools: [{ serverId: "s1", exposedName: "search" }] });
    const nextWith = warmFingerprint({
      ...base,
      mcpTools: [
        { serverId: "s1", exposedName: "search" },
        { serverId: "s1", exposedName: "fetch" },
      ],
    });
    expect(nextWith).not.toBe(parkedWith);
    const h = await warmHarness({ warmRounds: { ...WARM, parkTtlMs: 10_000 } });
    await parkedRoundOne(h, { headSha: SHA_1, fingerprint: parkedWith });
    const spec2 = await followUp(h, "run-2", { fingerprint: nextWith });
    const handle = await h.launcher.launch(spec2);
    expect(await h.launcher.warmOutcome(handle)).toEqual({ adopted: false, reason: "fingerprint_changed" });
    expect(await h.runs.get("run-2")).toMatchObject({ round: 1, phase: "running", coldReason: "fingerprint_changed" });
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect(h.api.actors.has(`wardby-runs/${agentActorName(h.token)}`)).toBe(false);
  });

  it("cleans up and requeues when a resume finds no room; the relaunch is cold, for capacity", async () => {
    const h = await warmHarness();
    await parkedRoundOne(h);
    const spec2 = await followUp(h, "run-2");
    h.api.options.workers = 0;
    await expect(h.launcher.launch(spec2)).rejects.toBeInstanceOf(JobCapacityError);
    const planned = h.launcher.plannedHandle(spec2)!;
    expect(await h.runs.get("run-2")).toMatchObject({ token: h.token, phase: "requeued", round: 2 });
    expect(await h.launcher.warmOutcome(planned)).toEqual({ adopted: false, reason: "capacity" });
    expect(h.api.actors.size).toBe(0);
    expect(h.secrets.secrets.size).toBe(0);
    expect(await h.blobs.head(roundBlob(h.token))).toBeNull();
    h.api.options.workers = 2;
    const handle = await h.launcher.launch(spec2);
    // Round 1's names under the inherited token: a fresh seed and input, no round record.
    expect(await h.runs.get("run-2")).toMatchObject({
      token: h.token,
      phase: "running",
      round: 1,
      coldReason: "capacity",
    });
    expect(await h.launcher.warmOutcome(handle)).toEqual({ adopted: false, reason: "capacity" });
    expect(await restartedLauncher(h).warmOutcome(handle)).toEqual({ adopted: false, reason: "capacity" });
    expect(await h.blobs.head(BLOB.seed(h.token))).not.toBeNull();
    expect(await h.blobs.head(roundBlob(h.token))).toBeNull();
    await finishRound(h, h.token, "run-2", 1);
    expect(JSON.parse((await h.launcher.collect(handle)).resultArtifact!)).toMatchObject({ runId: "run-2" });
  });

  it("times out an adoption whose control plane stopped between the adoption and the phase write", async () => {
    const h = await warmHarness();
    await parkedRoundOne(h);
    // The adoption committed, then the process died: no resume, no phase write.
    const adopted = await h.runs.adopt("run-1", "run-2", new Date(1_000_000 + 600_000), { specHash: "x" });
    expect(adopted).toMatchObject({ runId: "run-2", token: h.token, phase: "provisioning" });
    const handle: JobHandle = { backend: "substrate", id: "wardby-runs/run-2" };
    expect((await h.launcher.status(handle)).state).toBe("pending");
    h.setNow(1_000_000 + 600_001);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
    expect((await h.runs.get("run-2"))!.phase).toBe("timed_out");
    // Cleaned up like any startup failure: the actors stop now, the rest goes on removal.
    expect([...h.api.actors.keys()].filter((key) => key.includes(h.token))).toEqual([]);
    await h.launcher.remove(handle);
    expect((await h.runs.get("run-2"))!.phase).toBe("removed");
    expect(h.api.egressPolicies.size).toBe(0);
    for (const key of (await allBlobs(h)).keys()) expect(key).not.toContain(h.token);
  });

  it("sweeps a parked run past its expiry, and once at start-up (warmUp)", async () => {
    const h = await warmHarness();
    await parkedRoundOne(h);
    h.setNow(1_000_000 + WARM.parkTtlMs + 1);
    await h.launcher.sweepParked();
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect(h.api.actors.size).toBe(0);
    expect(h.warmEvents.at(-1)).toMatchObject({ event: "substrate_warm_expired", runId: "run-1" });

    const s = await warmHarness();
    await parkedRoundOne(s);
    s.setNow(1_000_000 + WARM.parkTtlMs + 1);
    // A new control plane: its warm-up removes what expired while nothing swept.
    const restarted = new SubstrateJobLauncher({
      api: s.api,
      runs: s.runs,
      blobs: s.blobs,
      secrets: s.secrets,
      relay: s.relay,
      bridgeToolImages: [TOOL_IMAGE],
      config: CONFIG,
      workspaceRoot: s.workspaceRoot,
      resolveCapability: async () => FAKE_CAP,
      now: () => 1_000_000 + WARM.parkTtlMs + 1,
      warmRounds: WARM,
      onWarmEvent: () => undefined,
    });
    await restarted.warmUp();
    expect((await s.runs.get("run-1"))!.phase).toBe("removed");
    expect(s.api.actors.size).toBe(0);
    // Without warm rounds, warm-up has nothing left to remove.
    await expect(restartedLauncher(s, null).warmUp()).resolves.toBeUndefined();
  });

  describe("turning warm rounds off", () => {
    it("removes every kept round at start-up (warmUp), expired or not, and the sweep does too", async () => {
      const h = await warmHarness();
      await parkedRoundOne(h);
      expect(h.api.actors.size).toBe(2);
      const off = restartedLauncher(h, null);
      await off.warmUp();
      expect((await h.runs.get("run-1"))!.phase).toBe("removed");
      expect(h.api.actors.size).toBe(0);
      expect(h.api.egressPolicies.size).toBe(0);
      expect([...(await allBlobs(h)).keys()]).toEqual([]);

      const s = await warmHarness();
      await parkedRoundOne(s);
      await restartedLauncher(s, null).sweepParked();
      expect((await s.runs.get("run-1"))!.phase).toBe("removed");
      expect(s.api.actors.size).toBe(0);
    });

    it("launch and the capacity probe sweep kept rounds too, and never park or adopt", async () => {
      const h = await warmHarness();
      await parkedRoundOne(h);
      const off = restartedLauncher(h, null);
      const spec2 = await followUp(h, "run-2");
      const handle = await off.launch(spec2);
      expect(handle.id).toBe(`wardby-runs/${substrateRunToken("run-2")}`);
      expect(await h.runs.get("run-2")).toMatchObject({ token: substrateRunToken("run-2"), round: 1 });
      expect((await h.runs.get("run-1"))!.phase).toBe("removed");
      expect([...h.api.actors.keys()].filter((key) => key.includes(h.token))).toEqual([]);

      const s = await warmHarness();
      await parkedRoundOne(s);
      await restartedLauncher(s, null).hasCapacityFor(await otherRun(s, "run-3"));
      expect((await s.runs.get("run-1"))!.phase).toBe("removed");
    });

    it("removes a later round in flight when it was turned off in full, every round's files included", async () => {
      const h = await warmHarness();
      await parkedRoundOne(h);
      const second = await h.launcher.launch(await followUp(h, "run-2"));
      await finishRound(h, h.token, "run-2", 2);
      await h.blobs.put(BLOB.transcript(h.token, 2), Buffer.from("t"));
      const off = restartedLauncher(h, null);
      expect((await off.status(second)).state).toBe("succeeded");
      await off.remove(second);
      expect((await h.runs.get("run-2"))!.phase).toBe("removed");
      expect([...h.api.actors.keys()].filter((key) => key.includes(h.token))).toEqual([]);
      for (const key of (await allBlobs(h)).keys()) expect(key).not.toContain(h.token);
    });
  });

  it("does not adopt an expired park (launch's own sweep removes it first)", async () => {
    const h = await warmHarness();
    await parkedRoundOne(h);
    h.setNow(1_000_000 + WARM.parkTtlMs + 60_000);
    const handle = await h.launcher.launch(await followUp(h, "run-2"));
    expect(handle.id).toBe("wardby-runs/run-2");
    expect(await h.runs.get("run-2")).toMatchObject({ token: substrateRunToken("run-2"), round: 1 });
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect(await h.launcher.warmOutcome(handle)).toEqual({ adopted: false, reason: "not_parked" });
  });

  it("caps parks at parkMax: the oldest is removed for a new one (one without parkedAt counts as the oldest)", async () => {
    const h = await warmHarness({ warmRounds: { ...WARM, parkMax: 2 } });
    await parkedRoundOne(h);
    // A park from before parkedAt was recorded (a spike-era row).
    const legacy = await otherRun(h, "run-legacy");
    const legacyHandle = await h.launcher.launch(legacy);
    await finishRound(h, substrateRunToken("run-legacy"), "run-legacy", 1);
    expect((await h.launcher.status(legacyHandle)).state).toBe("succeeded");
    await h.runs.park("run-legacy", { parkedAt: undefined as unknown as Date, round: 1, expiresAt: new Date(9e12) });
    // A third run, parked later: the cap is 2, so the legacy park goes, then run-1 stays.
    h.setNow(1_000_500);
    const third = await otherRun(h, "run-b");
    const thirdHandle = await h.launcher.launch(third);
    await finishRound(h, substrateRunToken("run-b"), "run-b", 1);
    expect(await h.launcher.retain(thirdHandle, RETAIN)).toBe(true);
    expect((await h.runs.get("run-legacy"))!.phase).toBe("removed");
    expect((await h.runs.get("run-1"))!.phase).toBe("parked");
    expect((await h.runs.get("run-b"))!.phase).toBe("parked");
    expect(h.warmEvents.filter((e) => e.event === "substrate_warm_evicted")).toEqual([
      {
        event: "substrate_warm_evicted",
        runId: "run-legacy",
        runToken: substrateRunToken("run-legacy"),
        reason: "park_max",
      },
    ]);
    // And the next park removes run-1, the oldest by parkedAt.
    h.setNow(1_000_900);
    const fourth = await otherRun(h, "run-c");
    const fourthHandle = await h.launcher.launch(fourth);
    await finishRound(h, substrateRunToken("run-c"), "run-c", 1);
    expect(await h.launcher.retain(fourthHandle, RETAIN)).toBe(true);
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect(await h.runs.countParked()).toBe(2);
    expect(h.api.actors.has(`wardby-runs/${agentActorName(h.token)}`)).toBe(false);
  });

  it("parks never block a run: with no room, the oldest parks are removed first (never the one continued)", async () => {
    // One worker with room for one run's two actors (750m + 250m), where a parked run keeps its room.
    const h = await warmHarness({
      workers: 1,
      workerSize: { cpuMillicores: 1000, memoryBytes: 8 * 2 ** 30 },
      suspendedHoldRoom: true,
    });
    await parkedRoundOne(h);
    // The continuation of the parked run: its own park is kept, so there is no room for a cold start.
    expect(await h.launcher.hasCapacityFor(await followUp(h, "run-2"))).toBe(false);
    expect((await h.runs.get("run-1"))!.phase).toBe("parked");
    // Another run: the park goes, and then it fits.
    const other = await otherRun(h, "run-b");
    expect(await h.launcher.hasCapacityFor(other)).toBe(true);
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect(h.warmEvents.at(-1)).toEqual({
      event: "substrate_warm_evicted",
      runId: "run-1",
      runToken: h.token,
      reason: "capacity",
    });
  });

  it("launch() removes parks for room too, before provisioning", async () => {
    const h = await warmHarness({
      workers: 1,
      workerSize: { cpuMillicores: 1000, memoryBytes: 8 * 2 ** 30 },
      suspendedHoldRoom: true,
    });
    await parkedRoundOne(h);
    const handle = await h.launcher.launch(await otherRun(h, "run-b"));
    expect((await h.runs.get("run-b"))!.phase).toBe("running");
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect(await h.launcher.warmOutcome(handle)).toBeUndefined();
  });

  it("a capacity-short probe removes at most one park where suspended actors give back their room", async () => {
    const h = await warmHarness();
    await parkedRoundOne(h);
    const b = await otherRun(h, "run-b");
    const handleB = await h.launcher.launch(b);
    await finishRound(h, substrateRunToken("run-b"), "run-b", 1);
    h.setNow(1_000_100);
    expect(await h.launcher.retain(handleB, RETAIN)).toBe(true);
    // Workers too small for any run: removing parks frees nothing, so one removal shows it.
    h.api.options.workerSize = { cpuMillicores: 500, memoryBytes: 2 ** 30 };
    expect(await h.launcher.hasCapacityFor(await otherRun(h, "run-c"))).toBe(false);
    expect(h.warmEvents.filter((e) => e.event === "substrate_warm_evicted").map((e) => e.runId)).toEqual(["run-1"]);
    expect((await h.runs.get("run-b"))!.phase).toBe("parked");
  });

  it("where a park holds its room, removes parks one at a time and stops once the run fits", async () => {
    // One worker with room for two runs; each park keeps its room.
    const h = await warmHarness({
      workers: 1,
      workerSize: { cpuMillicores: 2000, memoryBytes: 16 * 2 ** 30 },
      suspendedHoldRoom: true,
    });
    await parkedRoundOne(h);
    const handleB = await h.launcher.launch(await otherRun(h, "run-b"));
    await finishRound(h, substrateRunToken("run-b"), "run-b", 1);
    h.setNow(1_000_100);
    expect(await h.launcher.retain(handleB, RETAIN)).toBe(true);
    expect(await h.launcher.hasCapacityFor(await otherRun(h, "run-c"))).toBe(true);
    expect(h.warmEvents.filter((e) => e.event === "substrate_warm_evicted").map((e) => e.runId)).toEqual(["run-1"]);
    expect((await h.runs.get("run-b"))!.phase).toBe("parked");
  });

  it("holds parkMax across control planes after the fact: two retains at once leave one park", async () => {
    const warm = { ...WARM, parkMax: 1 };
    const h = await warmHarness({ warmRounds: warm });
    const other = restartedLauncher(h, warm);
    const handleA = await h.launcher.launch(h.spec);
    const handleB = await other.launch(await otherRun(h, "run-b"));
    await finishRound(h, h.token, "run-1", 1);
    await finishRound(h, substrateRunToken("run-b"), "run-b", 1);
    // Both retains pass every step before parking (the relay purge) before either parks.
    const purge = h.relay.purgeRelay.bind(h.relay);
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    h.relay.purgeRelay = async (token: string) => {
      if (++waiting === 2) release();
      await both;
      return purge(token);
    };
    expect(await Promise.all([h.launcher.retain(handleA, RETAIN), other.retain(handleB, RETAIN)])).toEqual([
      true,
      true,
    ]);
    expect(await h.runs.countParked()).toBe(1);
    // Parked at the same moment: ordered by run id, so run-1 is the older and goes.
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect((await h.runs.get("run-b"))!.phase).toBe("parked");
    expect(h.warmEvents.filter((e) => e.event === "substrate_warm_evicted")).toEqual([
      { event: "substrate_warm_evicted", runId: "run-1", runToken: h.token, reason: "park_max" },
    ]);
  });

  it("two removals of one park at once both succeed", async () => {
    const h = await warmHarness();
    const handle = await parkedRoundOne(h);
    const other = restartedLauncher(h);
    // Both have expired the park before either records it removed.
    const setPhase = h.runs.setPhase.bind(h.runs);
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    h.runs.setPhase = async (...args: Parameters<typeof setPhase>) => {
      if (args[1] === "removed" && args[0] === "run-1") {
        if (++waiting === 2) release();
        await both;
      }
      return setPhase(...args);
    };
    await expect(Promise.all([h.launcher.remove(handle), other.remove(handle)])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect(h.api.actors.size).toBe(0);
  });

  it("reports nothing for a second launch of the same continuation that lost the adoption", async () => {
    const h = await warmHarness();
    await parkedRoundOne(h);
    const other = restartedLauncher(h);
    const spec2 = await followUp(h, "run-2");
    // Both launches reach the adoption before either takes it.
    const adopt = h.runs.adopt.bind(h.runs);
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    h.runs.adopt = async (...args: Parameters<typeof adopt>) => {
      if (++waiting === 2) release();
      await both;
      return adopt(...args);
    };
    const [a, b] = await Promise.all([h.launcher.launch(spec2), other.launch(spec2)]);
    expect(a).toEqual(b);
    expect(await h.runs.get("run-2")).toMatchObject({ token: h.token, round: 2, phase: "running" });
    expect(h.warmEvents.filter((e) => e.event === "substrate_warm_not_adopted")).toEqual([]);
    expect(h.warmEvents.filter((e) => e.event === "substrate_warm_adopted")).toHaveLength(1);
    expect(await h.launcher.warmOutcome(a)).toEqual({ adopted: true });
  });

  it("says expired, not not_parked, when the park expires between the checks and the adoption", async () => {
    const h = await warmHarness({ warmRounds: { ...WARM, parkTtlMs: 10_000 } });
    await parkedRoundOne(h);
    const adopt = h.runs.adopt.bind(h.runs);
    h.runs.adopt = async (...args: Parameters<typeof adopt>) => {
      h.setNow(1_000_000 + 10_001);
      return adopt(...args);
    };
    const handle = await h.launcher.launch(await followUp(h, "run-2"));
    expect(await h.runs.get("run-2")).toMatchObject({ token: substrateRunToken("run-2"), coldReason: "expired" });
    expect(await h.launcher.warmOutcome(handle)).toEqual({ adopted: false, reason: "expired" });
    expect(h.warmEvents.find((e) => e.event === "substrate_warm_not_adopted")).toEqual({
      event: "substrate_warm_not_adopted",
      runId: "run-2",
      runToken: h.token,
      adoptedRunId: "run-1",
      reason: "expired",
    });
  });

  it("an adoption and a removal of the same park: exactly one wins, and nothing resumes once deletion began", async () => {
    const outcomes = new Set<string>();
    for (let ticks = 0; ticks <= 40; ticks += 2) {
      const h = await warmHarness();
      const handle1 = await parkedRoundOne(h);
      const other = restartedLauncher(h);
      const calls: string[] = [];
      const api = h.api;
      const resume = api.resumeActor.bind(api);
      const del = api.deleteActor.bind(api);
      api.resumeActor = async (atespace: string, name: string) => {
        calls.push(`resume ${name}`);
        return resume(atespace, name);
      };
      api.deleteActor = async (atespace: string, name: string) => {
        calls.push(`delete ${name}`);
        return del(atespace, name);
      };
      const spec2 = await followUp(h, "run-2");
      const removal = (async () => {
        for (let i = 0; i < ticks; i += 1) await Promise.resolve();
        await other.remove(handle1);
      })();
      await Promise.all([h.launcher.launch(spec2), removal]);
      const run2 = (await h.runs.get("run-2"))!;
      const mine = (c: string) => c.endsWith(agentActorName(h.token)) || c.endsWith(toolActorName(h.token));
      const resumes = calls.filter((c) => c.startsWith("resume") && mine(c));
      const deletes = calls.filter((c) => c.startsWith("delete") && mine(c));
      if (run2.token === h.token) {
        outcomes.add("adopted");
        expect(run2).toMatchObject({ round: 2, phase: "running" });
        expect(deletes).toEqual([]);
        expect(actorStates(h, h.token)).toEqual(["RUNNING", "RUNNING"]);
      } else {
        outcomes.add("removed");
        expect(run2).toMatchObject({ token: substrateRunToken("run-2"), round: 1 });
        expect(resumes).toEqual([]);
        expect(h.api.actors.has(`wardby-runs/${agentActorName(h.token)}`)).toBe(false);
      }
      expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    }
    expect([...outcomes].sort()).toEqual(["adopted", "removed"]);
  });

  it("records the spec's agent on the row, on a cold launch and on an adoption", async () => {
    const h = await warmHarness();
    await h.launcher.launch({ ...h.spec, agentId: "agent-1" });
    expect(await h.runs.get("run-1")).toMatchObject({ agentId: "agent-1" });
    await finishRound(h, h.token, "run-1", 1);
    expect(await h.launcher.retain(h.launcher.plannedHandle(h.spec)!, RETAIN)).toBe(true);
    await h.launcher.launch({ ...(await followUp(h, "run-2")), agentId: "agent-1" });
    expect(await h.runs.get("run-2")).toMatchObject({ agentId: "agent-1", round: 2 });
  });

  it("removeParked({ agentId }) removes that agent's parks only, in full, with substrate_warm_removed", async () => {
    const h = await warmHarness();
    const handle = await h.launcher.launch({ ...h.spec, agentId: "agent-1" });
    await finishRound(h, h.token, "run-1", 1);
    expect(await h.launcher.retain(handle, RETAIN)).toBe(true);
    const other = await otherRun(h, "run-2");
    const otherHandle = await h.launcher.launch({ ...other, agentId: "agent-2" });
    const otherToken = substrateRunToken("run-2");
    await finishRound(h, otherToken, "run-2", 1);
    expect(await h.launcher.retain(otherHandle, RETAIN)).toBe(true);
    h.warmEvents.length = 0;

    expect(await h.launcher.removeParked({ agentId: "agent-3" })).toBe(0);
    expect(await h.launcher.removeParked({ agentId: "agent-1" })).toBe(1);
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect((await h.runs.get("run-2"))!.phase).toBe("parked");
    expect(h.api.actors.has(`wardby-runs/${agentActorName(h.token)}`)).toBe(false);
    expect(actorStates(h, otherToken)).toEqual(["SUSPENDED", "SUSPENDED"]);
    expect(h.warmEvents).toEqual([
      { event: "substrate_warm_removed", runId: "run-1", runToken: h.token, reason: "agent" },
    ]);
    // Already gone: nothing more to remove.
    expect(await h.launcher.removeParked({ agentId: "agent-1" })).toBe(0);
  });

  it("removeParked() is 0 with nothing kept, and leaves a park it cannot remove to the sweep", async () => {
    const off = await makeHarness();
    expect(await off.launcher.removeParked({ agentId: "agent-1" })).toBe(0);
    const h = await warmHarness();
    const handle = await h.launcher.launch({ ...h.spec, agentId: "agent-1" });
    await finishRound(h, h.token, "run-1", 1);
    expect(await h.launcher.retain(handle, RETAIN)).toBe(true);
    const deleteActor = h.api.deleteActor.bind(h.api);
    h.api.deleteActor = async () => {
      throw new Error("substrate_down");
    };
    await expect(h.launcher.removeParked({ agentId: "agent-1" })).resolves.toBe(0);
    h.api.deleteActor = deleteActor;
    expect((await h.runs.get("run-1"))!.phase).toBe("parked");
  });

  it("after a restart (a new launcher on the same store), adopts, then status, collect, retain and remove a warm round", async () => {
    const h = await warmHarness();
    await parkedRoundOne(h);
    const restarted = restartedLauncher(h);
    const spec2 = await followUp(h, "run-2");
    const planned = restarted.plannedHandle(spec2)!;
    // The park survives the restart: the new instance adopts it.
    expect(await restarted.launch(spec2)).toEqual(planned);
    expect(await restarted.warmOutcome(planned)).toEqual({ adopted: true });
    expect((await restarted.status(planned)).state).toBe("running");
    await finishRound(h, h.token, "run-2", 2);
    expect(JSON.parse((await restarted.collect(planned)).resultArtifact!)).toMatchObject({ runId: "run-2" });
    expect(await restarted.retain(planned, RETAIN)).toBe(true);
    expect(await h.runs.get("run-2")).toMatchObject({ phase: "parked", round: 2 });
    await restarted.remove(planned);
    expect((await h.runs.get("run-2"))!.phase).toBe("removed");
    expect(h.api.actors.size).toBe(0);
    expect([...(await allBlobs(h)).keys()]).toEqual([]);
  });

  it("reads either handle form whatever the setting, so a run keeps its handle when warm rounds are switched", async () => {
    // A run launched with warm rounds off, read by a launcher with them on.
    const cold = await makeHarness();
    const phaseA = await cold.launcher.launch(cold.spec);
    expect(phaseA.id).toBe(`wardby-runs/${cold.token}`);
    expect((await restartedLauncher(cold).status(phaseA)).state).toBe("running");
    // A run launched with them on, read by a launcher with them off.
    const h = await warmHarness();
    const warmHandle = await h.launcher.launch(h.spec);
    expect((await restartedLauncher(h, null).status(warmHandle)).state).toBe("running");
    // Neither form names another atespace's run, or a malformed one.
    await expect(h.launcher.status({ backend: "substrate", id: "other/run-1" })).rejects.toThrow("job_not_found");
    await expect(h.launcher.status({ backend: "substrate", id: "wardby-runs/run-1/x" })).rejects.toThrow(
      "job_not_found",
    );
  });

  it("keeps every capability and registry token out of templates, policies, rows, blobs (but the tool setup), events and logs", async () => {
    const h = await warmHarness();
    const stdout: string[] = [];
    const writeOut = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk: string) => (stdout.push(String(chunk)), true);
    process.stderr.write = (chunk: string) => (stdout.push(String(chunk)), true);
    // Every server log line, as written.
    setLogLineFilter((line) => (stdout.push(line), line));
    // A launcher without an event sink logs its warm events: those are captured too.
    const logged = restartedLauncher(h, WARM);
    (logged as unknown as { options: { onWarmEvent?: unknown } }).options.onWarmEvent = undefined;
    try {
      // MCP runs, so their MCP tokens are checked too.
      const first = await h.launcher.launch({ ...h.spec, mcpTools: true });
      await finishRound(h, h.token, "run-1", 1);
      expect((await h.launcher.status(first)).state).toBe("succeeded");
      expect(await h.launcher.retain(first, RETAIN)).toBe(true);
      // While parked, nothing anywhere holds round 1's capability or MCP token (the Secret is gone).
      expect(JSON.stringify([...h.secrets.secrets.values()])).not.toContain(FAKE_CAP);
      expect(JSON.stringify([...h.secrets.secrets.values()])).not.toContain(FAKE_MCP);
      const second = await logged.launch({ ...(await followUp(h, "run-2")), mcpTools: true });
      expect(await logged.warmOutcome(second)).toEqual({ adopted: true });
      await finishRound(h, h.token, "run-2", 2);
      await logged.retain(second, RETAIN);
      await logged.launch({ ...(await followUp(h, "run-3", { from: "run-2", headSha: SHA_2 })), mcpTools: true });
      // A run with extra repositories (cold, never adopting), whose setup and seeds are blobs too.
      await logged.launch(await withExtras(h, await otherRun(h, "run-4")));
    } finally {
      process.stdout.write = writeOut;
      process.stderr.write = writeErr;
      setLogLineFilter((line) => line);
    }
    const shapes = [FAKE_CAP, CAP_2, CAP_3, "rrg_", FAKE_MCP, FAKE_MCP_2, FAKE_MCP_3, "rmt_"];
    const rows = await Promise.all(["run-1", "run-2", "run-3", "run-4"].map((id) => h.runs.get(id)));
    expect(rows[3]?.repositories).toEqual(EXTRAS);
    const outputs = [
      JSON.stringify([...h.api.templates.values()]),
      JSON.stringify([...h.api.egressPolicies.values()]),
      JSON.stringify(h.warmEvents),
      JSON.stringify(h.callFailures),
      JSON.stringify(rows),
      stdout.join(""),
    ];
    for (const [key, body] of await allBlobs(h)) {
      if (!key.endsWith("tool-setup.json")) outputs.push(body);
      // The tool setup holds the registry token (derived from the capability), never an MCP token.
      else for (const mcp of [FAKE_MCP, FAKE_MCP_2, FAKE_MCP_3]) expect(body).not.toContain(mcp);
    }
    for (const output of outputs) for (const shape of shapes) expect(output).not.toContain(shape);
    // Warm events carry fixed fields only: never the commit or the fingerprint either.
    const allowed = new Set(["event", "runId", "runToken", "round", "adoptedRunId", "reason", "ms", "steps"]);
    for (const event of h.warmEvents) for (const key of Object.keys(event)) expect(allowed.has(key)).toBe(true);
    expect(JSON.stringify(h.warmEvents)).not.toContain(FP);
    expect(JSON.stringify(h.warmEvents)).not.toContain(SHA_1);
    // The logged events reached the log (so the check above saw them).
    if (logger.isLevelEnabled("info")) expect(stdout.join("")).toContain("substrate_warm_not_adopted");
  });
});

describe("warm rounds and Codex (single actor)", () => {
  it("never parks a succeeded Codex run: retain removes it and answers false", async () => {
    const h = await makeHarness({ provider: "codex", warmRounds: WARM });
    const handle = await h.launcher.launch(h.spec);
    await h.blobs.put(BLOB.result(h.token), Buffer.from(JSON.stringify(h.output)));
    await h.blobs.put(BLOB.done(h.token), Buffer.from('{"workspace":"ok"}'));
    expect(await h.launcher.status(handle)).toEqual({ state: "succeeded" });
    const suspended: string[] = [];
    h.api.suspendActor = async (_atespace, name) => {
      suspended.push(name);
    };
    expect(await h.launcher.retain(handle, RETAIN)).toBe(false);
    expect(suspended).toEqual([]);
    expect((await h.runs.get(h.spec.runId))?.phase).toBe("removed");
    expect(await h.runs.countParked()).toBe(0);
    expect(h.api.actors.size).toBe(0);
    expect(h.secrets.secrets.size).toBe(0);
    expect(h.warmEvents).toEqual([]);
  });
});
