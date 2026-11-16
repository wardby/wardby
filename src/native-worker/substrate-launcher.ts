/**
 * Launches, watches, stops and removes native sandbox workers as Substrate actors
 * (NATIVE_SANDBOX_LAUNCHER=substrate). Like the Docker and Kubernetes launchers it keeps no state of
 * its own a run depends on: the actor's name derives from the run id (`<token>-native`), its state
 * comes from Substrate, and sessions live in Postgres, so any replica can act on any run.
 *
 * Topology: one actor per run, resumed from the native template's golden snapshot. The worker inside
 * reaches only the native gateway, through Substrate's egress gateway, which puts the run's
 * capability (read from a per-run Kubernetes Secret) in the Authorization header on the wire. The
 * worker itself holds only a public placeholder and fetches its input from the gateway once its
 * actor's name appears (substrate-mode.ts).
 *
 * A launch, in order: wake the gateway (low-power mode); ensure the template; check for room; the
 * Secret; the actor (a stale one under the name is deleted and created again, never taken over);
 * its egress policy; then resume. Every policy exists before the resume, so the session is ready at
 * launch (`networkReadyAtLaunch`, D1): nothing runs in the actor before its egress is pinned (the
 * canary, Task 7, proves the template's denials once per template). A resume refused for room is
 * retried while the template's golden snapshot may still be building (`goldenWaitMs` after its first
 * ensure); past that it is native_sandbox_capacity. Any failure deletes what the launch made.
 *
 * Nothing per run is in the template (it is shared by every run and snapshotted before any run
 * exists), and nothing secret is in the template or the policy (Substrate logs both). Run errors
 * and log lines are a fixed code plus enums: Substrate's and Kubernetes's messages are never read.
 *
 * `inspect` reads the run's session as well as the actor: the worker idles after its `finish`
 * (an exited PID 1 would show as a crash), so a running actor whose session has ended is reported
 * as exited 0. A CRASHED actor is exited 1; a deleted one is missing.
 *
 * No warm pool: golden snapshots make a cold start cheap, and the composition refuses
 * NATIVE_SANDBOX_WARM_POOL_SIZE with this launcher. There is no actor list in our SubstrateApi, so
 * the executor sweeps from session rows (`listsWorkers = false`).
 */

import { logger } from "../core/logger.js";
import { DISABLED_POWER, wakeTimeoutMs, type Power } from "../core/power.js";
import {
  KubernetesAlreadyExistsError,
  KubernetesNotFoundError,
  type KubernetesApi,
} from "../providers/jobs/kubernetes-api.js";
import {
  createFreshActor,
  ensureTemplate,
  SubstrateGoldenSnapshotFailedError,
  substrateErrorCode,
  type NamedCall,
  type SubstrateCall,
} from "../providers/substrate/actors.js";
import { SubstrateExhaustedError, type ActorTemplateSpec, type SubstrateApi } from "../providers/substrate/api.js";
import { nativeActorName, substrateRunToken } from "../providers/substrate/names.js";
import { canPlaceAll, type Room } from "../providers/substrate/placement.js";
import type { NativeWorkerState } from "./docker-launcher.js";
import { NATIVE_SANDBOX_CAPACITY } from "./kubernetes-launcher.js";
import { NATIVE_SANDBOX_LAUNCH_ABANDONED, type WorkerHandle, type WorkerLaunchOptions } from "./launch.js";
import type { WorkerInput } from "./protocol.js";
import type { ManagedWorkerLauncher } from "./sandbox-executor.js";
import { nativeEgress, nativeRunSecret, nativeTemplate, type NativeSubstrateLaunchConfig } from "./substrate-specs.js";

const substrateNativeLog = logger.child({ module: "native-substrate-launcher" });

/** A Substrate or Secret call of a native launch failed: `<call>: <fixed code>` follows. */
export const NATIVE_SANDBOX_SUBSTRATE_FAILED = "native_sandbox_substrate_failed";

export type NativeSubstrateCall = SubstrateCall | "createSecret" | "deleteSecret";

export interface NativeSubstrateCallFailure {
  runId: string;
  substrateCall: NativeSubstrateCall;
  errorCode: string;
}

export interface SubstrateNativeWorkerLauncherOptions {
  api: SubstrateApi;
  secrets: Pick<KubernetesApi, "createSecret" | "deleteSecret">;
  config: NativeSubstrateLaunchConfig;
  /** Whether the run's gateway session is still active (composition: the ledger). */
  sessionActive: (runId: string) => Promise<boolean>;
  /** SUBSTRATE_NATIVE_GOLDEN_WAIT_SEC in ms. */
  goldenWaitMs: number;
  power?: Power;
  /** inspect polling, default 1000. */
  pollMs?: number;
  /** golden-window resume retry, default 2000. */
  retryMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Default: the module logger, warn. */
  onCallFailed?: (failure: NativeSubstrateCallFailure) => void;
}

const CAPACITY_MESSAGE = `${NATIVE_SANDBOX_CAPACITY}: no Substrate worker has room for another native worker.`;

/** A named call failed: carries only the call's name and the original error (whose message is never read). */
class NamedCallFailed extends Error {
  constructor(
    readonly call: NativeSubstrateCall,
    readonly original: unknown,
  ) {
    super(`${NATIVE_SANDBOX_SUBSTRATE_FAILED}: ${call}`);
  }
}

/** No worker has room (the pre-check, or a resume refused past the golden window). */
class NoRoom extends Error {}

/** The run error for a failed launch: a fixed code and enums, never a message from Substrate or Kubernetes. */
function launchError(error: unknown): Error {
  if (error instanceof NoRoom) return new Error(CAPACITY_MESSAGE);
  if (error instanceof NamedCallFailed) {
    // A Kubernetes error is never a Substrate one, so a Secret failure is always `unexpected`.
    return new Error(`${NATIVE_SANDBOX_SUBSTRATE_FAILED}: ${error.call}: ${substrateErrorCode(error.original)}`);
  }
  return new Error(`${NATIVE_SANDBOX_SUBSTRATE_FAILED}: launch: unexpected`);
}

export class SubstrateNativeWorkerLauncher implements ManagedWorkerLauncher {
  readonly networkReadyAtLaunch = true;
  /** No actor list in our SubstrateApi: the executor sweeps from session rows (Task 6). */
  readonly listsWorkers = false;

  private readonly template: ActorTemplateSpec;
  private readonly power: Power;
  /** When each template was first ensured by this process: its golden snapshot may build until goldenWaitMs after. */
  private readonly firstEnsuredAt = new Map<string, number>();
  private preparing: Promise<void> | undefined;

  constructor(private readonly options: SubstrateNativeWorkerLauncherOptions) {
    // Built once, so a size that rounds to nothing fails at startup (substrate_limits_too_small).
    this.template = nativeTemplate(options.config);
    this.power = options.power ?? DISABLED_POWER;
  }

  private get api(): SubstrateApi {
    return this.options.api;
  }
  private get atespace(): string {
    return this.options.config.atespace;
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private sleep(ms: number): Promise<void> {
    return (this.options.sleep ?? ((t) => new Promise((resolve) => setTimeout(resolve, t))))(ms);
  }

  /** Fixed fields only; never throws. */
  private report(failure: NativeSubstrateCallFailure): void {
    try {
      if (this.options.onCallFailed) this.options.onCallFailed(failure);
      else substrateNativeLog.warn({ ...failure }, "substrate_call_failed");
    } catch {
      // Reporting never changes the outcome.
    }
  }

  /**
   * A NamedCall for one run: a failure is reported and rethrown as NamedCallFailed. An error
   * `recoverable` names is rethrown as it is, unreported: the caller recovers from it.
   */
  private callFor(runId: string): NamedCall {
    return async <T>(
      name: NativeSubstrateCall,
      fn: () => Promise<T>,
      recoverable?: (error: unknown) => boolean,
    ): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        if (recoverable?.(error)) throw error;
        if (error instanceof NamedCallFailed) throw error;
        this.report({ runId, substrateCall: name, errorCode: substrateErrorCode(error) });
        throw new NamedCallFailed(name, error);
      }
    };
  }

  /** Ensures the template; a golden-failed one is recreated, and its golden window starts again. */
  private async ensure(call: NamedCall): Promise<void> {
    const info = await ensureTemplate(this.api, this.template, call);
    if (info?.goldenSnapshotFailed || !this.firstEnsuredAt.has(this.template.name)) {
      this.firstEnsuredAt.set(this.template.name, this.now());
    }
  }

  /** Ensures the template (and, Task 7, runs the canary); a failure is logged with fixed fields only. */
  private async prepare(): Promise<void> {
    const call: NamedCall = async (name, fn) => {
      try {
        return await fn();
      } catch (error) {
        substrateNativeLog.warn(
          { substrateCall: name, errorCode: substrateErrorCode(error) },
          "native substrate template not prepared",
        );
        throw new NamedCallFailed(name, error);
      }
    };
    try {
      await this.ensure(call);
    } catch {
      // Logged above; the next launch ensures it again.
    }
  }

  /** Starts preparing the template in the background and returns at once; a launch waits for it. */
  async start(): Promise<void> {
    this.preparing ??= this.prepare();
  }

  async resolveGatewayUrl(): Promise<string> {
    return this.options.config.gatewayUrl;
  }

  async launch(input: WorkerInput, launchOptions: WorkerLaunchOptions = {}): Promise<WorkerHandle> {
    const runId = input.runId;
    if (!input.gateway) throw new Error(`${NATIVE_SANDBOX_SUBSTRATE_FAILED}: launch: input_invalid`);
    const capability = input.gateway.capability;
    // Low-power mode: the gateway may be scaled to zero; wake it before anything is created.
    if (this.power.enabled) {
      await this.power.ensureAwake("gateway", { timeoutMs: wakeTimeoutMs(120_000), runId });
    }
    // A wake can take minutes: a run stopped meanwhile gets no actor.
    if (launchOptions.stillWanted && !(await launchOptions.stillWanted())) {
      throw new Error(
        `${NATIVE_SANDBOX_LAUNCH_ABANDONED}: the run ended while its worker was launching; no worker was started.`,
      );
    }
    // Never race the background ensure (start).
    if (this.preparing) await this.preparing;

    const token = substrateRunToken(runId);
    const actor = nativeActorName(token);
    const call = this.callFor(runId);
    let secretMade = false;
    let actorMade = false;
    try {
      await this.ensure(call);
      if (!(await this.hasRoom(runId))) throw new NoRoom();
      secretMade = true;
      await this.createSecret(runId, token, capability);
      actorMade = true;
      await createFreshActor(this.api, this.atespace, actor, this.template.name, call);
      await call("putEgressPolicy", () =>
        this.api.putEgressPolicy(this.atespace, actor, nativeEgress(token, this.options.config)),
      );
      await this.resume(runId, actor, call);
    } catch (error) {
      await this.cleanUp(token, actor, { secret: secretMade, actor: actorMade });
      throw launchError(error);
    }
    return this.handleFor(runId, (code) => this.logExit(runId, code));
  }

  /** Room on a worker the selector matches; a listWorkers failure skips the check (the resume decides). */
  private async hasRoom(runId: string): Promise<boolean> {
    let free: Room[];
    try {
      const selector = Object.entries(this.options.config.workerSelector ?? {});
      free = (await this.api.listWorkers())
        .filter((worker) => selector.every(([key, value]) => worker.labels?.[key] === value))
        .map((worker) => ({ cpuMillicores: worker.freeCpuMillicores, memoryBytes: worker.freeMemoryBytes }));
    } catch (error) {
      this.report({ runId, substrateCall: "listWorkers", errorCode: substrateErrorCode(error) });
      return true;
    }
    const size = { cpuMillicores: this.template.cpuMillicores, memoryBytes: this.template.memoryBytes };
    return canPlaceAll(free, [size]);
  }

  /** The per-run Secret; one left by an earlier attempt is deleted and created again. */
  private async createSecret(runId: string, token: string, capability: string): Promise<void> {
    const { secrets, config } = this.options;
    try {
      try {
        await secrets.createSecret(config.credentialsNamespace, nativeRunSecret(token, capability, config));
      } catch (error) {
        if (!(error instanceof KubernetesAlreadyExistsError)) throw error;
        await this.deleteSecret(token);
        await secrets.createSecret(config.credentialsNamespace, nativeRunSecret(token, capability, config));
      }
    } catch (error) {
      // A Kubernetes error's message may quote the request (the Secret): only a fixed code is kept.
      this.report({ runId, substrateCall: "createSecret", errorCode: "unexpected" });
      throw new NamedCallFailed("createSecret", error);
    }
  }

  /**
   * Resumes the actor. Refused for room while the template's golden snapshot may still be building
   * (goldenWaitMs after its first ensure): retried every retryMs, rechecking the template each time
   * (a golden build that failed for good ends the wait). Past the window: no room.
   */
  private async resume(runId: string, actor: string, call: NamedCall): Promise<void> {
    const exhausted = (error: unknown) => error instanceof SubstrateExhaustedError;
    for (;;) {
      try {
        await call("resumeActor", () => this.api.resumeActor(this.atespace, actor), exhausted);
        return;
      } catch (error) {
        if (!exhausted(error)) throw error;
        const since = this.firstEnsuredAt.get(this.template.name) ?? this.now();
        if (this.now() - since >= this.options.goldenWaitMs) {
          this.report({ runId, substrateCall: "resumeActor", errorCode: substrateErrorCode(error) });
          throw new NoRoom();
        }
      }
      await this.sleep(this.options.retryMs ?? 2_000);
      await call("getActorTemplate", async () => {
        const info = await this.api.getActorTemplate(this.atespace, this.template.name);
        if (info?.goldenSnapshotFailed) throw new SubstrateGoldenSnapshotFailedError("golden snapshot failed");
        return info;
      });
    }
  }

  /** Best effort: the policy, the actor, the Secret, each as far as the launch got. */
  private async cleanUp(token: string, actor: string, made: { secret: boolean; actor: boolean }): Promise<void> {
    if (made.actor) {
      await this.api.deleteEgressPolicy(this.atespace, actor).catch(() => {});
      await this.api.deleteActor(this.atespace, actor).catch(() => {});
    }
    if (made.secret) await this.deleteSecret(token).catch(() => {});
  }

  private async deleteSecret(token: string): Promise<void> {
    try {
      await this.options.secrets.deleteSecret(this.options.config.credentialsNamespace, token);
    } catch (error) {
      if (!(error instanceof KubernetesNotFoundError)) throw error;
    }
  }

  /** A non-zero exit, with fixed fields only: Substrate gives no output to tail (D5). */
  private async logExit(runId: string, code: number): Promise<void> {
    if (code === 0) return;
    substrateNativeLog.warn({ runId, code, stderrTailOmitted: "not_available" }, "native worker exited non-zero");
  }

  handle(runId: string): WorkerHandle {
    return this.handleFor(runId);
  }

  private handleFor(runId: string, onExit?: (code: number) => Promise<void>): WorkerHandle {
    const exited = (async () => {
      for (;;) {
        const state = await this.inspect(runId).catch(() => undefined);
        if (state?.state === "exited") {
          await onExit?.(state.exitCode).catch(() => {});
          return state.exitCode;
        }
        if (state?.state === "missing") return null;
        await this.sleep(this.options.pollMs ?? 1_000);
      }
    })();
    return { exited, kill: () => void this.kill(runId).catch(() => {}) };
  }

  async inspect(runId: string): Promise<NativeWorkerState> {
    const actor = nativeActorName(substrateRunToken(runId));
    let info;
    try {
      info = await this.api.getActor(this.atespace, actor);
    } catch (error) {
      // No cause: Substrate's message may quote a request, and this error reaches the executor's log.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`${NATIVE_SANDBOX_SUBSTRATE_FAILED}: getActor: ${substrateErrorCode(error)}`);
    }
    if (!info) return { state: "missing" };
    if (info.state === "CRASHED") return { state: "exited", exitCode: 1 };
    // The worker idles after its finish: an ended session is its exit.
    if (!(await this.options.sessionActive(runId))) return { state: "exited", exitCode: 0 };
    return { state: "running" };
  }

  /** Deletes the actor (its policy goes with it). */
  async kill(runId: string): Promise<void> {
    const actor = nativeActorName(substrateRunToken(runId));
    try {
      await this.api.deleteActor(this.atespace, actor);
    } catch (error) {
      const errorCode = substrateErrorCode(error);
      this.report({ runId, substrateCall: "deleteActor", errorCode });
      // No cause: Substrate's message may quote a request.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`${NATIVE_SANDBOX_SUBSTRATE_FAILED}: deleteActor: ${errorCode}`);
    }
  }

  /** The policy, the actor and the Secret; each missing one is success. All three are tried; the first failure is thrown. */
  async remove(runId: string): Promise<void> {
    const token = substrateRunToken(runId);
    const actor = nativeActorName(token);
    const steps: [NativeSubstrateCall, () => Promise<void>][] = [
      ["deleteEgressPolicy", () => this.api.deleteEgressPolicy(this.atespace, actor)],
      ["deleteActor", () => this.api.deleteActor(this.atespace, actor)],
      ["deleteSecret", () => this.deleteSecret(token)],
    ];
    let first: Error | undefined;
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (error) {
        const errorCode = substrateErrorCode(error);
        this.report({ runId, substrateCall: name, errorCode });
        first ??= new Error(`${NATIVE_SANDBOX_SUBSTRATE_FAILED}: ${name}: ${errorCode}`);
      }
    }
    if (first) throw first;
  }

  /** No actor list in our SubstrateApi: always empty (the executor sweeps from session rows). */
  async listWorkers(): Promise<{ name: string; runHash: string }[]> {
    return [];
  }

  async removeByWorkerName(_name: string): Promise<void> {}
}
