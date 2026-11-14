// Warm rounds (SUBSTRATE_WARM_ROUNDS, experimental spike): park on remove, adopt on continuation.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobCapacityError, type JobHandle, type JobSpec } from "../types.js";
import { CONFIG, FAKE_CAP, makeHarness, type Harness } from "./launcher.test-support.js";
import type { WarmRoundsOptions } from "./launcher.js";
import { BLOB, agentActorName, retiredRunToken, roundBlob, substrateRunToken, toolActorName } from "./names.js";
import { agentTemplate, toolTemplate, WARM_ROUNDS_ENV } from "./specs.js";

const WARM: WarmRoundsOptions = { parkTtlMs: 3_600_000, secret: "same" };
const CAP_2 = "rrp_fake_capability_value_000002";
const CAP_3 = "rrp_fake_capability_value_000003";
const CAPS: Record<string, string> = { "run-1": FAKE_CAP, "run-2": CAP_2, "run-3": CAP_3 };
const MODEL = "claude-sonnet-5";

async function warmHarness(options: { warmRounds?: WarmRoundsOptions } = {}): Promise<Harness> {
  const h = await makeHarness({
    warmRounds: options.warmRounds ?? WARM,
    capabilityFor: (runId) => CAPS[runId] ?? FAKE_CAP,
  });
  await writeFile(h.spec.inputArtifact, JSON.stringify({ schemaVersion: 1, runId: "run-1", model: MODEL, task: "1" }));
  return h;
}

/** A follow-up run's spec: its own input (continuing run-1, the thread's root) and workspace. */
async function followUp(h: Harness, runId: string, model = MODEL): Promise<JobSpec> {
  await mkdir(join(h.workspaceRoot, runId, "workspace"), { recursive: true });
  await writeFile(join(h.workspaceRoot, runId, "workspace", "README.md"), "# hello\n");
  const inputArtifact = join(h.root, `input-${runId}.json`);
  await writeFile(
    inputArtifact,
    JSON.stringify({ schemaVersion: 1, runId, model, task: `task of ${runId}`, continuationOf: { runId: "run-1" } }),
  );
  return { ...h.spec, runId, inputArtifact };
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

/** Every file the blob store holds, with its contents. */
async function allBlobs(h: Harness): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, await readFile(path, "utf8"));
    }
  };
  await walk(join(h.root, "blobs"), "");
  return out;
}

async function parkedRoundOne(h: Harness): Promise<JobHandle> {
  const handle = await h.launcher.launch(h.spec);
  await finishRound(h, h.token, "run-1", 1);
  expect((await h.launcher.status(handle)).state).toBe("succeeded");
  await h.launcher.remove(handle);
  return handle;
}

describe("SubstrateJobLauncher without warm rounds", () => {
  it("keeps today's handle, templates and removal", async () => {
    const h = await makeHarness();
    expect(h.launcher.plannedHandle(h.spec)).toEqual({ backend: "substrate", id: `wardby-runs/${h.token}` });
    const handle = await h.launcher.launch(h.spec);
    expect(handle.id).toBe(`wardby-runs/${h.token}`);
    for (const template of h.api.templates.values()) {
      expect(template.containers[0].env!.map((e) => e.name)).toEqual(["WARDBY_PROXY_URL"]);
    }
    await finishRound(h, h.token, "run-1", 1);
    await h.launcher.remove(handle);
    expect(h.api.actors.size).toBe(0);
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect(h.secrets.secrets.size).toBe(0);
  });
});

describe("SubstrateJobLauncher with warm rounds", () => {
  it("gives the bridges the warm-rounds switch through the templates (their own templates)", async () => {
    const h = await warmHarness();
    expect(h.launcher.plannedHandle(h.spec)).toBeUndefined();
    const handle = await h.launcher.launch(h.spec);
    expect(handle.id).toBe(`wardby-runs/${h.token}/run-1`);
    for (const template of h.api.templates.values()) {
      expect(template.containers[0].env).toContainEqual({ name: WARM_ROUNDS_ENV, value: "1" });
    }
    expect(agentTemplate(h.spec, CONFIG).name).not.toBe(agentTemplate(h.spec, { ...CONFIG, warmRounds: true }).name);
    expect(toolTemplate(h.spec, CONFIG).name).not.toBe(toolTemplate(h.spec, { ...CONFIG, warmRounds: true }).name);
  });

  it("parks a succeeded run on remove: actors suspended, Secret and policies kept, still succeeded", async () => {
    const h = await warmHarness();
    const handle = await parkedRoundOne(h);
    const record = await h.runs.get("run-1");
    expect(record!.phase).toBe("parked");
    expect(record!.deadlineAt.getTime()).toBe(1_000_000 + WARM.parkTtlMs);
    expect(actorStates(h, h.token)).toEqual(["SUSPENDED", "SUSPENDED"]);
    expect(h.api.egressPolicies.size).toBe(2);
    expect(h.secrets.secrets.has(`${CONFIG.credentialsNamespace}/${h.token}`)).toBe(true);
    expect(await h.blobs.head(BLOB.seed(h.token))).toBeNull();
    expect(await h.blobs.head(BLOB.workspace(h.token))).toBeNull();
    expect(await h.blobs.head(BLOB.result(h.token))).not.toBeNull();
    const result = await h.launcher.collect(handle);
    expect(result).toMatchObject({ exitCode: 0, reason: "completed" });
    expect(JSON.parse(result.resultArtifact!)).toMatchObject({ runId: "run-1" });
    expect(h.warmEvents.map((e) => e.event)).toEqual(["substrate_warm_parked"]);
    expect(h.warmEvents[0]).toMatchObject({ runId: "run-1", runToken: h.token, round: 1 });
  });

  it("does not park a failed run", async () => {
    const h = await warmHarness();
    const handle = await h.launcher.launch(h.spec);
    await h.blobs.put(BLOB.done(h.token), Buffer.from('{"workspace":"failed"}'));
    await h.launcher.remove(handle);
    expect(h.api.actors.size).toBe(0);
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
  });

  it("removes a parked run in full when remove() is called on it again", async () => {
    const h = await warmHarness();
    const handle = await parkedRoundOne(h);
    await h.launcher.remove(handle);
    expect(h.api.actors.size).toBe(0);
    expect(h.api.egressPolicies.size).toBe(0);
    expect(h.secrets.secrets.size).toBe(0);
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect([...(await allBlobs(h)).keys()]).toEqual([]);
  });

  it("adopts the parked actors for a continuation: same token, round 2, new capability, resumed", async () => {
    const h = await warmHarness();
    const first = await parkedRoundOne(h);
    const spec2 = await followUp(h, "run-2");
    const handle = await h.launcher.launch(spec2);
    expect(handle.id).toBe(`wardby-runs/${h.token}/run-2`);
    // The rows: run-2 holds run-1's token; run-1 is adopted under a retired token.
    expect(await h.runs.get("run-2")).toMatchObject({ token: h.token, phase: "running" });
    expect(await h.runs.get("run-1")).toMatchObject({ token: retiredRunToken("run-1"), phase: "adopted" });
    // No new actors, no seed: the same two, resumed.
    expect(h.api.actors.size).toBe(2);
    expect(actorStates(h, h.token)).toEqual(["RUNNING", "RUNNING"]);
    expect(await h.blobs.head(BLOB.seed(h.token))).toBeNull();
    expect(JSON.parse((await h.blobs.get(roundBlob(h.token))).toString())).toEqual({ round: 2 });
    expect(JSON.parse((await h.blobs.get(BLOB.input(h.token, 2))).toString())).toMatchObject({ runId: "run-2" });
    expect(await h.blobs.head(BLOB.toolSetup(h.token))).not.toBeNull();
    // The Secret was replaced under the same name with the new run's capability.
    expect(h.secrets.secrets.get(`${CONFIG.credentialsNamespace}/${h.token}`)!.stringData).toEqual({
      capability: CAP_2,
    });
    expect(h.secrets.calls.slice(-2)).toEqual([
      `delete ${CONFIG.credentialsNamespace}/${h.token}`,
      `create ${CONFIG.credentialsNamespace}/${h.token}`,
    ]);
    expect(h.warmEvents.at(-1)).toMatchObject({
      event: "substrate_warm_adopted",
      runId: "run-2",
      adoptedRunId: "run-1",
      round: 2,
    });
    expect(Object.keys(h.warmEvents.at(-1)!.steps!)).toEqual(["stage", "secret", "resumeTool", "resumeAgent"]);
    // Round 1's handle names nothing now: removing it touches nothing of run-2.
    await expect(h.launcher.status(first)).rejects.toThrow("job_not_found");
    await h.launcher.remove(first);
    expect(actorStates(h, h.token)).toEqual(["RUNNING", "RUNNING"]);
    // So does a two-part handle for the token (it is no longer run-1's own).
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
  });

  it("chains: round 2 parks and round 3 adopts it (round 3 files), then a removal deletes every round", async () => {
    const h = await warmHarness();
    await parkedRoundOne(h);
    const second = await h.launcher.launch(await followUp(h, "run-2"));
    await finishRound(h, h.token, "run-2", 2);
    await h.launcher.remove(second);
    expect((await h.runs.get("run-2"))!.phase).toBe("parked");
    const third = await h.launcher.launch(await followUp(h, "run-3"));
    expect(third.id).toBe(`wardby-runs/${h.token}/run-3`);
    expect(JSON.parse((await h.blobs.get(roundBlob(h.token))).toString())).toEqual({ round: 3 });
    expect(await h.runs.get("run-2")).toMatchObject({ token: retiredRunToken("run-2"), phase: "adopted" });
    await h.blobs.put(BLOB.done(h.token, 3), Buffer.from('{"workspace":"failed"}'));
    await h.launcher.remove(third);
    expect(h.api.actors.size).toBe(0);
    expect(h.secrets.secrets.size).toBe(0);
    expect([...(await allBlobs(h)).keys()]).toEqual([]);
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

  it("launches cold, and removes the parked run, when the continuation does not fit it", async () => {
    const h = await warmHarness();
    await parkedRoundOne(h);
    const spec2 = await followUp(h, "run-2", "claude-opus-5");
    const handle = await h.launcher.launch(spec2);
    expect(handle.id).toBe(`wardby-runs/${substrateRunToken("run-2")}/run-2`);
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect(h.api.actors.has(`wardby-runs/${agentActorName(h.token)}`)).toBe(false);
    expect(h.warmEvents.find((e) => e.event === "substrate_warm_not_adopted")).toMatchObject({
      reason: "model_changed",
      adoptedRunId: "run-1",
    });
  });

  it("launches cold for a run that continues nothing", async () => {
    const h = await warmHarness();
    await parkedRoundOne(h);
    const spec2 = await followUp(h, "run-2");
    await writeFile(spec2.inputArtifact, JSON.stringify({ schemaVersion: 1, runId: "run-2", model: MODEL }));
    const handle = await h.launcher.launch(spec2);
    expect(handle.id).toBe(`wardby-runs/${substrateRunToken("run-2")}/run-2`);
    expect((await h.runs.get("run-1"))!.phase).toBe("parked");
  });

  it("sweeps a parked run past its expiry", async () => {
    const h = await warmHarness();
    await parkedRoundOne(h);
    h.setNow(1_000_000 + WARM.parkTtlMs + 1);
    await h.launcher.sweepParked();
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
    expect(h.api.actors.size).toBe(0);
    expect(h.warmEvents.at(-1)).toMatchObject({ event: "substrate_warm_expired", runId: "run-1" });
  });

  it("does not adopt an expired park (launch's own sweep removes it first)", async () => {
    const h = await warmHarness();
    await parkedRoundOne(h);
    h.setNow(1_000_000 + WARM.parkTtlMs + 60_000);
    const handle = await h.launcher.launch(await followUp(h, "run-2"));
    expect(handle.id).toBe(`wardby-runs/${substrateRunToken("run-2")}/run-2`);
    expect((await h.runs.get("run-1"))!.phase).toBe("removed");
  });

  it("with a fresh Secret per round: a new name, the agent policy re-pointed, the old Secret gone", async () => {
    const h = await warmHarness({ warmRounds: { ...WARM, secret: "fresh" } });
    await parkedRoundOne(h);
    await h.launcher.launch(await followUp(h, "run-2"));
    const ns = CONFIG.credentialsNamespace;
    expect([...h.secrets.secrets.keys()]).toEqual([`${ns}/${h.token}-r2`]);
    expect(h.secrets.secrets.get(`${ns}/${h.token}-r2`)!.stringData).toEqual({ capability: CAP_2 });
    const policy = h.api.egressPolicies.get(`wardby-runs/${agentActorName(h.token)}`)!;
    expect(JSON.stringify(policy)).toContain(`/${ns}/${h.token}-r2/capability`);
  });

  it("cleans up and requeues when a resume finds no room", async () => {
    const h = await warmHarness();
    await parkedRoundOne(h);
    h.api.options.workers = 0;
    await expect(h.launcher.launch(await followUp(h, "run-2"))).rejects.toBeInstanceOf(JobCapacityError);
    expect(await h.runs.get("run-2")).toMatchObject({ token: h.token, phase: "requeued" });
    expect(h.api.actors.size).toBe(0);
    expect(h.secrets.secrets.size).toBe(0);
    expect(await h.blobs.head(roundBlob(h.token))).toBeNull();
  });

  it("keeps every capability out of templates, policies, blobs (but the tool setup) and warm events", async () => {
    const h = await warmHarness();
    const stdout: string[] = [];
    const writeOut = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk: string) => (stdout.push(String(chunk)), true);
    process.stderr.write = (chunk: string) => (stdout.push(String(chunk)), true);
    try {
      await parkedRoundOne(h);
      await h.launcher.launch(await followUp(h, "run-2"));
    } finally {
      process.stdout.write = writeOut;
      process.stderr.write = writeErr;
    }
    const shapes = [FAKE_CAP, CAP_2, "rrg_"];
    const outputs = [
      JSON.stringify([...h.api.templates.values()]),
      JSON.stringify([...h.api.egressPolicies.values()]),
      JSON.stringify(h.warmEvents),
      JSON.stringify(h.callFailures),
      stdout.join(""),
    ];
    for (const [key, body] of await allBlobs(h)) {
      if (!key.endsWith("tool-setup.json")) outputs.push(body);
    }
    for (const output of outputs) for (const shape of shapes) expect(output).not.toContain(shape);
  });
});
