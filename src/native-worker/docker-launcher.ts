/**
 * Launches, watches, stops, and removes native sandbox workers on the local
 * Docker engine (docs/native-sandbox.md), from the isolation plan in
 * docker-isolation.ts. Every operation is idempotent and keyed by the run id,
 * so the executor can retry, a second launch attaches instead of starting
 * twice, and a restarted server re-finds a running worker by name.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { logger } from "../core/logger.js";
import {
  buildGatewayConnectArgs,
  buildGatewayDisconnectArgs,
  buildNativeNetworkCreateArgs,
  buildNativeWarmNetworkCreateArgs,
  buildNativeWarmWorkerRunArgs,
  buildNativeWorkerRunArgs,
  gatewayConnectArgs,
  gatewayDisconnectArgs,
  nativeIsolationNames,
  nativeWarmIsolationNames,
  NATIVE_WARM_LABEL_FILTER,
  NATIVE_WARM_TOKEN_LABEL,
  NATIVE_WORKER_LABEL_FILTER,
  type NativeWorkerLimits,
} from "./docker-isolation.js";
import type { DetachedWorkerLauncher, WorkerHandle } from "./launch.js";
import type { WorkerInput } from "./protocol.js";
import { warmDeliveryCommand } from "./warm-delivery.js";
import { NATIVE_SANDBOX_WARM_DELIVERY_FAILED, type WarmWorkerLauncher } from "./warm-pool.js";

const launcherLog = logger.child({ module: "native-docker-launcher" });

export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The Docker CLI as this launcher uses it; tests replace it. */
export interface DockerCli {
  run(args: string[], options?: { input?: string; timeoutMs?: number }): Promise<DockerResult>;
}

export function processDockerCli(binary = "docker"): DockerCli {
  return {
    run(args, options = {}) {
      return new Promise((resolve) => {
        const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("error", (err) => resolve({ code: null, stdout, stderr: err.message }));
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
        child.stdin.on("error", () => {});
        child.stdin.end(options.input ?? "");
      });
    },
  };
}

export type NativeWorkerState = { state: "running" } | { state: "exited"; exitCode: number } | { state: "missing" };

export interface DockerNativeWorkerLauncherOptions {
  image: string;
  /** The container running `wardby native-gateway`, joined to each run's network. */
  gatewayContainer: string;
  limits: NativeWorkerLimits;
  docker?: DockerCli;
}

export class DockerNativeWorkerLauncher implements DetachedWorkerLauncher, WarmWorkerLauncher {
  private readonly docker: DockerCli;

  constructor(private readonly options: DockerNativeWorkerLauncherOptions) {
    this.docker = options.docker ?? processDockerCli();
  }

  private async must(args: string[], what: string, tolerate?: RegExp): Promise<DockerResult> {
    const result = await this.docker.run(args);
    if (result.code !== 0 && !(tolerate && tolerate.test(result.stderr))) {
      throw new Error(`native_sandbox_docker_failed: ${what}: ${result.stderr.trim().slice(0, 500)}`);
    }
    return result;
  }

  /** The image must be present and pinned; a digest is pulled once, a local id must already exist. */
  private async ensureImage(): Promise<void> {
    const present = await this.docker.run(["image", "inspect", "--format", "{{.Id}}", this.options.image]);
    if (present.code === 0) return;
    await this.must(["image", "pull", "--quiet", this.options.image], "pull the worker image");
  }

  async launch(input: WorkerInput): Promise<WorkerHandle> {
    const runId = input.runId;
    const names = nativeIsolationNames(runId);
    const existing = await this.inspect(runId);
    if (existing.state === "missing") {
      await this.ensureImage();
      await this.must(buildNativeNetworkCreateArgs(runId), "create the run network", /already exists/);
      await this.must(
        buildGatewayConnectArgs(runId, this.options.gatewayContainer),
        "join the gateway to the run network",
        /already exists|is already connected/,
      );
      const args = buildNativeWorkerRunArgs({ runId, image: this.options.image, limits: this.options.limits });
      // Attached so the input (capability included) goes in on stdin; the exit is read with
      // `docker wait`, which a restarted server can call again.
      void this.docker.run(args, { input: `${JSON.stringify(input)}\n` }).then((result) => {
        if (result.code !== 0 && result.code !== null && !/Conflict/.test(result.stderr)) {
          launcherLog.warn({ container: names.worker, code: result.code }, "native worker exited non-zero");
        }
      });
    } else {
      launcherLog.info({ container: names.worker }, "native worker already exists: attaching, not relaunching");
    }
    return this.handle(runId);
  }

  /** Waits for (and reports) the worker's exit; usable after a server restart. */
  handle(runId: string): WorkerHandle {
    return this.handleByName(nativeIsolationNames(runId).worker);
  }

  private handleByName(name: string): WorkerHandle {
    const exited = (async () => {
      // `docker run` may not have created the container yet: wait for it to exist (bounded).
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const waited = await this.docker.run(["container", "wait", name]);
        if (waited.code === 0) {
          const code = Number(waited.stdout.trim());
          return Number.isInteger(code) ? code : null;
        }
        if (!/No such container/i.test(waited.stderr)) return null;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return null;
    })();
    return { exited, kill: () => void this.docker.run(["container", "kill", name]) };
  }

  async inspect(runId: string): Promise<NativeWorkerState> {
    return this.inspectByName(nativeIsolationNames(runId).worker);
  }

  private async inspectByName(name: string): Promise<NativeWorkerState> {
    const result = await this.docker.run([
      "container",
      "inspect",
      "--format",
      "{{.State.Status}} {{.State.ExitCode}}",
      name,
    ]);
    if (result.code !== 0) return { state: "missing" };
    const [status, exitCode] = result.stdout.trim().split(" ");
    if (status === "running" || status === "created" || status === "restarting") return { state: "running" };
    return { state: "exited", exitCode: Number(exitCode) };
  }

  async kill(runId: string): Promise<void> {
    await this.docker.run(["container", "kill", nativeIsolationNames(runId).worker]);
  }

  /** Removes the worker, its network, and the gateway's membership of it. Idempotent. */
  async remove(runId: string): Promise<void> {
    const names = nativeIsolationNames(runId);
    await this.docker.run(["container", "rm", "--force", names.worker]);
    await this.docker.run(buildGatewayDisconnectArgs(runId, this.options.gatewayContainer));
    await this.docker.run(["network", "rm", names.network]);
  }

  /** Removes a worker found by the janitor, by its container name (its network shares the name's token). */
  async removeByWorkerName(workerName: string): Promise<void> {
    const token = /^wardby-native-([0-9a-f]{20})$/.exec(workerName)?.[1];
    if (!token) return;
    await this.docker.run(["container", "rm", "--force", workerName]);
    await this.docker.run(["network", "disconnect", "--force", `wardby-nnet-${token}`, this.options.gatewayContainer]);
    await this.docker.run(["network", "rm", `wardby-nnet-${token}`]);
  }

  /** Every native worker container this engine holds, with its run-hash label (for the janitor). */
  async listWorkers(): Promise<{ name: string; runHash: string }[]> {
    const result = await this.docker.run([
      "container",
      "ls",
      "--all",
      "--filter",
      `label=${NATIVE_WORKER_LABEL_FILTER}`,
      "--format",
      '{{.Names}} {{.Label "io.wardby.run-sha256"}}',
    ]);
    if (result.code !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim().split(" "))
      .filter(([name, runHash]) => name && runHash)
      .map(([name, runHash]) => ({ name, runHash }));
  }

  // --- Warm pool workers (native sandbox phase 6) ---

  warmSpecHash(waitMs: number): string {
    const { image, limits, gatewayContainer } = this.options;
    return createHash("sha256")
      .update(JSON.stringify({ launcher: "docker", image, limits, gatewayContainer, waitMs }))
      .digest("hex");
  }

  /** Its network is internal from creation, so a running container is already isolated: claimable. */
  async startWarm(token: string, waitMs: number): Promise<void> {
    const names = nativeWarmIsolationNames(token);
    try {
      await this.ensureImage();
      await this.must(buildNativeWarmNetworkCreateArgs(token), "create the warm worker network", /already exists/);
      await this.must(
        gatewayConnectArgs(names.network, this.options.gatewayContainer),
        "join the gateway to the warm worker network",
        /already exists|is already connected/,
      );
      await this.must(
        buildNativeWarmWorkerRunArgs({ token, image: this.options.image, limits: this.options.limits, waitMs }),
        "start the warm worker",
      );
    } catch (err) {
      await this.removeWarm(token).catch(() => {});
      throw err;
    }
  }

  /** Still running, and attached to its own network and nothing else. */
  async reattestWarm(token: string): Promise<boolean> {
    const names = nativeWarmIsolationNames(token);
    const result = await this.docker.run([
      "container",
      "inspect",
      "--format",
      "{{.State.Status}} {{json .NetworkSettings.Networks}}",
      names.worker,
    ]);
    if (result.code !== 0) return false;
    const [status, ...rest] = result.stdout.trim().split(" ");
    try {
      const networks = Object.keys(JSON.parse(rest.join(" ")) as Record<string, unknown>);
      return status === "running" && networks.length === 1 && networks[0] === names.network;
    } catch {
      return false;
    }
  }

  async deliver(token: string, input: WorkerInput): Promise<void> {
    const result = await this.docker.run(
      ["container", "exec", "-i", nativeWarmIsolationNames(token).worker, ...warmDeliveryCommand()],
      { input: `${JSON.stringify(input)}\n`, timeoutMs: 20_000 },
    );
    if (result.code !== 0) {
      throw new Error(
        `${NATIVE_SANDBOX_WARM_DELIVERY_FAILED}: delivering the run's input exited ${result.code ?? "?"}.`,
      );
    }
  }

  warmHandle(token: string): WorkerHandle {
    return this.handleByName(nativeWarmIsolationNames(token).worker);
  }

  inspectWarm(token: string): Promise<NativeWorkerState> {
    return this.inspectByName(nativeWarmIsolationNames(token).worker);
  }

  async killWarm(token: string): Promise<void> {
    await this.docker.run(["container", "kill", nativeWarmIsolationNames(token).worker]);
  }

  async removeWarm(token: string): Promise<void> {
    const names = nativeWarmIsolationNames(token);
    await this.docker.run(["container", "rm", "--force", names.worker]);
    await this.docker.run(gatewayDisconnectArgs(names.network, this.options.gatewayContainer));
    await this.docker.run(["network", "rm", names.network]);
  }

  async listWarm(): Promise<string[]> {
    const result = await this.docker.run([
      "container",
      "ls",
      "--all",
      "--filter",
      `label=${NATIVE_WARM_LABEL_FILTER}`,
      "--format",
      `{{.Label "${NATIVE_WARM_TOKEN_LABEL}"}}`,
    ]);
    if (result.code !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((token) => /^[0-9a-f]{20}$/.test(token));
  }
}
