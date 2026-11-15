import {
  SubstrateAlreadyExistsError,
  SubstrateExhaustedError,
  SubstrateNotFoundError,
  SubstrateUnavailableError,
  type ActorInfo,
  type ActorState,
  type ActorTemplateSpec,
  type EgressRule,
  type SubstrateApi,
  type TemplateInfo,
  type WorkerInfo,
} from "./api.js";
import { pickWorker, type Room } from "./placement.js";

/** Each fake worker's capacity unless a test says otherwise: room for several default-sized runs. */
export const FAKE_WORKER_SIZE: Room = { cpuMillicores: 4000, memoryBytes: 8 * 2 ** 30 };

export interface FakeSubstrateOptions {
  workers: number;
  /** Every worker's capacity (default FAKE_WORKER_SIZE). */
  workerSize?: Room;
  /** Every worker's labels (default `{}`). */
  workerLabels?: Record<string, string>;
  /**
   * A suspended actor keeps the room it was placed on (default: it gives it back), for tests of a
   * backend where parked actors still take capacity.
   */
  suspendedHoldRoom?: boolean;
}

interface FakeActor {
  state: ActorState;
  templateName: string;
  /** The worker index a RUNNING actor holds room on. */
  worker?: number;
}

/**
 * In-memory SubstrateApi for tests. Maps are public so tests can assert on them. Like Substrate,
 * a worker holds many actors, bounded by its CPU and memory: an actor takes its template's size on
 * a worker when it resumes (the most free room that fits, as the launcher's capacity check
 * assumes) and gives it back when it stops running or is deleted.
 */
export class FakeSubstrateApi implements SubstrateApi {
  readonly templates = new Map<string, ActorTemplateSpec>();
  readonly actors = new Map<string, FakeActor>();
  readonly egressPolicies = new Map<string, EgressRule[]>();
  /** Templates whose golden snapshot build failed (see failGoldenSnapshot). */
  readonly goldenFailed = new Set<string>();
  /** Templates' golden-snapshot ready signal (see setGoldenSnapshotReady); absent: not reported. */
  readonly goldenReady = new Map<string, boolean>();
  constructor(readonly options: FakeSubstrateOptions) {}

  /** Like Substrate: an existing template is left as it is (AlreadyExists is success). */
  async ensureActorTemplate(spec: ActorTemplateSpec): Promise<void> {
    const key = `${spec.atespace}/${spec.name}`;
    if (!this.templates.has(key)) this.templates.set(key, structuredClone(spec));
  }
  async getActorTemplate(atespace: string, name: string): Promise<TemplateInfo | undefined> {
    const key = `${atespace}/${name}`;
    if (!this.templates.has(key)) return undefined;
    const info: TemplateInfo = { goldenSnapshotFailed: this.goldenFailed.has(key) };
    const ready = this.goldenReady.get(key);
    if (ready !== undefined) info.goldenSnapshotReady = ready;
    return info;
  }
  async deleteActorTemplate(atespace: string, name: string): Promise<void> {
    this.templates.delete(`${atespace}/${name}`);
    this.goldenFailed.delete(`${atespace}/${name}`);
    this.goldenReady.delete(`${atespace}/${name}`);
  }
  async createActor(atespace: string, name: string, template: string): Promise<void> {
    const key = `${atespace}/${name}`;
    // Substrate refuses an actor without a name (InvalidArgument, which the client reports as unavailable).
    if (!name) throw new SubstrateUnavailableError("substrate_unavailable");
    if (!this.templates.has(`${atespace}/${template}`)) throw new SubstrateNotFoundError("substrate_not_found");
    if (this.actors.has(key)) throw new SubstrateAlreadyExistsError(key);
    this.actors.set(key, { state: "SUSPENDED", templateName: template });
  }
  async getActor(atespace: string, name: string): Promise<ActorInfo | undefined> {
    const actor = this.actors.get(`${atespace}/${name}`);
    return actor ? { state: actor.state, templateName: actor.templateName } : undefined;
  }
  async resumeActor(atespace: string, name: string): Promise<void> {
    const actor = this.actors.get(`${atespace}/${name}`);
    if (!actor) throw new SubstrateNotFoundError("substrate_not_found");
    if (actor.state === "RUNNING") return;
    // Still holding its room (suspendedHoldRoom): it resumes where it was.
    if (actor.worker !== undefined) {
      actor.state = "RUNNING";
      return;
    }
    const worker = pickWorker(this.free(), this.sizeOf(atespace, actor));
    if (worker === undefined) throw new SubstrateExhaustedError("no worker has room");
    actor.state = "RUNNING";
    actor.worker = worker;
  }
  /** Like Substrate: a running actor gives back its room; a suspended one is returned as it is. */
  async suspendActor(atespace: string, name: string): Promise<void> {
    const actor = this.actors.get(`${atespace}/${name}`);
    if (!actor) throw new SubstrateNotFoundError("substrate_not_found");
    actor.state = "SUSPENDED";
    if (!this.options.suspendedHoldRoom) delete actor.worker;
  }
  async deleteActor(atespace: string, name: string): Promise<void> {
    this.actors.delete(`${atespace}/${name}`);
    // The policy belongs to the actor and goes with it.
    this.egressPolicies.delete(`${atespace}/${name}`);
  }
  /** Like Substrate's foreign key from a policy to its actor: the actor must exist. */
  async putEgressPolicy(atespace: string, actor: string, rules: EgressRule[]): Promise<void> {
    if (!this.actors.has(`${atespace}/${actor}`)) throw new SubstrateNotFoundError("substrate_not_found");
    this.egressPolicies.set(`${atespace}/${actor}`, structuredClone(rules));
  }
  async deleteEgressPolicy(atespace: string, actor: string): Promise<void> {
    this.egressPolicies.delete(`${atespace}/${actor}`);
  }
  async listWorkers(): Promise<WorkerInfo[]> {
    return this.free().map((room) => ({
      pool: "fake",
      labels: { ...this.options.workerLabels },
      freeCpuMillicores: room.cpuMillicores,
      freeMemoryBytes: room.memoryBytes,
    }));
  }
  /** Test hook: the template's golden snapshot build failed for good. */
  failGoldenSnapshot(atespace: string, name: string): void {
    this.goldenFailed.add(`${atespace}/${name}`);
  }
  /**
   * Test hook: the template's golden-snapshot status (true: tagged; false: a status without a tag
   * yet; undefined: no status reported, the default).
   */
  setGoldenSnapshotReady(atespace: string, name: string, ready: boolean | undefined): void {
    const key = `${atespace}/${name}`;
    if (ready === undefined) this.goldenReady.delete(key);
    else this.goldenReady.set(key, ready);
  }
  /** Test hook: put an actor in a state (e.g. CRASHED); only a RUNNING actor holds room. */
  setState(atespace: string, name: string, state: ActorState): void {
    const actor = this.actors.get(`${atespace}/${name}`);
    if (!actor) return;
    actor.state = state;
    if (state !== "RUNNING") delete actor.worker;
  }

  private sizeOf(atespace: string, actor: FakeActor): Room {
    const template = this.templates.get(`${atespace}/${actor.templateName}`);
    if (!template) throw new SubstrateNotFoundError("substrate_not_found");
    return { cpuMillicores: template.cpuMillicores, memoryBytes: template.memoryBytes };
  }

  /** Each worker's free room: its capacity less the RUNNING actors placed on it. */
  private free(): Room[] {
    const size = this.options.workerSize ?? FAKE_WORKER_SIZE;
    const rooms = Array.from({ length: this.options.workers }, () => ({ ...size }));
    for (const [key, actor] of this.actors) {
      const room = actor.worker === undefined ? undefined : rooms[actor.worker];
      const holds = actor.state === "RUNNING" || (actor.state === "SUSPENDED" && this.options.suspendedHoldRoom);
      if (!holds || !room) continue;
      const used = this.sizeOf(key.slice(0, key.indexOf("/")), actor);
      room.cpuMillicores -= used.cpuMillicores;
      room.memoryBytes -= used.memoryBytes;
    }
    return rooms;
  }
}
