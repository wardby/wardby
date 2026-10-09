import { describe, expect, it } from "vitest";
import { nativeIsolationNames } from "./docker-isolation.js";
import { DockerNativeWorkerLauncher, type DockerCli, type DockerResult } from "./docker-launcher.js";
import type { WorkerInput } from "./protocol.js";

const image = `ghcr.io/wardby/wardby/wardby-native-worker@sha256:${"a".repeat(64)}`;
const input = {
  runId: "run_1",
  gateway: { url: "http://wardby-native-gateway:8790/x", capability: "c".repeat(43) },
} as unknown as WorkerInput;
const names = nativeIsolationNames("run_1");
const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "" });
const no = (stderr: string): DockerResult => ({ code: 1, stdout: "", stderr });

/** A scripted Docker CLI: answers by the first matching rule and records every call. */
function fakeDocker(rules: Array<[RegExp, DockerResult | ((input?: string) => DockerResult)]>) {
  const calls: { args: string; input?: string }[] = [];
  const docker: DockerCli = {
    async run(args, options) {
      const joined = args.join(" ");
      calls.push({ args: joined, input: options?.input });
      const rule = rules.find(([pattern]) => pattern.test(joined));
      if (!rule) return ok();
      return typeof rule[1] === "function" ? rule[1](options?.input) : rule[1];
    },
  };
  return { docker, calls };
}

const launcher = (docker: DockerCli) =>
  new DockerNativeWorkerLauncher({
    image,
    gatewayContainer: "wardby-gateway",
    limits: { cpus: 1, memoryMb: 512, pids: 128 },
    docker,
  });

describe("DockerNativeWorkerLauncher", () => {
  it("launches a new worker: image, network, gateway join, then the run with its input on stdin", async () => {
    const { docker, calls } = fakeDocker([
      [/^container inspect/, no("Error: No such container")],
      [/^image inspect/, ok("sha256:abc")],
      [/^container wait/, ok("0\n")],
    ]);
    const handle = await launcher(docker).launch(input);
    expect(await handle.exited).toBe(0);
    const sequence = calls.map((c) => c.args.split(" ").slice(0, 2).join(" "));
    expect(sequence.slice(0, 5)).toEqual([
      "container inspect",
      "image inspect",
      "network create",
      "network connect",
      "run -i",
    ]);
    const run = calls.find((c) => c.args.startsWith("run -i"))!;
    // The capability travels only on stdin.
    expect(run.args).not.toContain("c".repeat(43));
    expect(run.input).toContain("c".repeat(43));
  });

  it("pulls a missing digest image before launching", async () => {
    const { docker, calls } = fakeDocker([
      [/^container inspect/, no("No such container")],
      [/^image inspect/, no("No such image")],
      [/^container wait/, ok("0")],
    ]);
    await launcher(docker).launch(input);
    expect(calls.some((c) => c.args === `image pull --quiet ${image}`)).toBe(true);
  });

  it("attaches to an existing worker instead of launching a second one", async () => {
    const { docker, calls } = fakeDocker([
      [/^container inspect/, ok("running 0")],
      [/^container wait/, ok("3")],
    ]);
    const handle = await launcher(docker).launch(input);
    expect(await handle.exited).toBe(3);
    expect(calls.some((c) => c.args.startsWith("run "))).toBe(false);
    expect(calls.some((c) => c.args.startsWith("network create"))).toBe(false);
  });

  it("tolerates a network or membership left by an earlier attempt", async () => {
    const { docker } = fakeDocker([
      [/^container inspect/, no("No such container")],
      [/^image inspect/, ok("x")],
      [/^network create/, no("Error response from daemon: network with name x already exists")],
      [/^network connect/, no("endpoint with name wardby-gateway already exists in network")],
      [/^container wait/, ok("0")],
    ]);
    await expect(launcher(docker).launch(input)).resolves.toBeDefined();
  });

  it("fails clearly when Docker refuses to create the network", async () => {
    const { docker } = fakeDocker([
      [/^container inspect/, no("No such container")],
      [/^image inspect/, ok("x")],
      [/^network create/, no("permission denied while trying to connect to the Docker daemon socket")],
    ]);
    await expect(launcher(docker).launch(input)).rejects.toThrow(
      /native_sandbox_docker_failed: create the run network/,
    );
  });

  it("reports state, kills, and removes everything idempotently", async () => {
    const { docker, calls } = fakeDocker([[/^container inspect/, ok("exited 137")]]);
    const l = launcher(docker);
    expect(await l.inspect("run_1")).toEqual({ state: "exited", exitCode: 137 });
    await l.kill("run_1");
    await l.remove("run_1");
    expect(calls.map((c) => c.args)).toEqual(
      expect.arrayContaining([
        `container kill ${names.worker}`,
        `container rm --force ${names.worker}`,
        `network disconnect --force ${names.network} wardby-gateway`,
        `network rm ${names.network}`,
      ]),
    );
    const missing = fakeDocker([[/^container inspect/, no("No such container")]]);
    expect(await launcher(missing.docker).inspect("run_1")).toEqual({ state: "missing" });
  });

  it("lists workers by label and removes one by name", async () => {
    const { docker, calls } = fakeDocker([[/^container ls/, ok(`${names.worker} abc123\nother-container \n`)]]);
    const l = launcher(docker);
    expect(await l.listWorkers()).toEqual([{ name: names.worker, runHash: "abc123" }]);
    await l.removeByWorkerName(names.worker);
    await l.removeByWorkerName("not-ours");
    expect(calls.filter((c) => c.args.startsWith("container rm"))).toHaveLength(1);
  });
});

describe("DockerNativeWorkerLauncher warm pool workers", () => {
  const token = "0123456789abcdef0123";
  const warm = { network: `wardby-nwnet-${token}`, worker: `wardby-nwarm-${token}` };

  it("starts a detached warm worker on its own internal network, with no input and no run label", async () => {
    const { docker, calls } = fakeDocker([[/^image inspect/, ok("sha256:abc")]]);
    await launcher(docker).startWarm(token, 60_000);
    const run = calls.find((c) => c.args.startsWith("run "))!;
    expect(run.args).toMatch(/^run -d --name wardby-nwarm-0123456789abcdef0123 /);
    expect(run.args).toContain(`--network ${warm.network}`);
    expect(run.args).toContain("--env NATIVE_WORKER_INPUT_FILE=/tmp/wardby-input/input.json");
    expect(run.args).toContain("--env NATIVE_WORKER_INPUT_WAIT_MS=60000");
    expect(run.args).toContain("--label io.wardby.pool=warm");
    expect(run.args).not.toContain("io.wardby.run-sha256");
    expect(run.input ?? "").toBe("");
    expect(calls.some((c) => c.args.startsWith("network create") && c.args.includes("--internal"))).toBe(true);
    expect(
      calls.some((c) => c.args === `network connect --alias wardby-native-gateway ${warm.network} wardby-gateway`),
    ).toBe(true);
  });

  it("removes what it made when the warm worker cannot start", async () => {
    const { docker, calls } = fakeDocker([
      [/^image inspect/, ok("sha256:abc")],
      [/^run /, no("boom")],
    ]);
    await expect(launcher(docker).startWarm(token, 60_000)).rejects.toThrow(/start the warm worker/);
    expect(calls.map((c) => c.args)).toEqual(
      expect.arrayContaining([`container rm --force ${warm.worker}`, `network rm ${warm.network}`]),
    );
  });

  it("delivers the input on exec stdin, never in the command", async () => {
    const { docker, calls } = fakeDocker([]);
    await launcher(docker).deliver(token, input);
    const call = calls.at(-1)!;
    expect(call.args).toMatch(new RegExp(`^container exec -i ${warm.worker} node -e `));
    expect(call.args).not.toContain(input.gateway!.capability);
    expect(JSON.parse(call.input!)).toEqual(input);
    const failing = fakeDocker([[/^container exec/, { code: 2, stdout: "", stderr: "" }]]);
    await expect(launcher(failing.docker).deliver(token, input)).rejects.toThrow(/native_sandbox_warm_delivery_failed/);
  });

  it("re-attests only a running worker attached to its own network alone", async () => {
    const answer = (stdout: string) => launcher(fakeDocker([[/^container inspect/, ok(stdout)]]).docker);
    expect(await answer(`running {"${warm.network}":{}}\n`).reattestWarm(token)).toBe(true);
    expect(await answer(`exited {"${warm.network}":{}}\n`).reattestWarm(token)).toBe(false);
    expect(await answer(`running {"${warm.network}":{},"bridge":{}}\n`).reattestWarm(token)).toBe(false);
    expect(await launcher(fakeDocker([[/^container inspect/, no("No such")]]).docker).reattestWarm(token)).toBe(false);
  });

  it("lists warm workers by token, which the run janitor's listing skips", async () => {
    const { docker } = fakeDocker([
      [/label=io.wardby.pool=warm/, ok(`${token}\nnot-a-token\n`)],
      [/label=io.wardby.component=native-worker/, ok(`${warm.worker} \n`)],
    ]);
    expect(await launcher(docker).listWarm()).toEqual([token]);
    expect(await launcher(docker).listWorkers()).toEqual([]);
  });
});
