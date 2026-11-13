import {
  SubstrateAlreadyExistsError,
  SubstrateExhaustedError,
  SubstrateNotFoundError,
  type ActorInfo,
  type ActorState,
  type ActorTemplateSpec,
  type EgressRule,
  type SubstrateApi,
  type WorkerInfo,
} from "./api.js";

/** In-memory SubstrateApi for tests. Maps are public so tests can assert on them. */
export class FakeSubstrateApi implements SubstrateApi {
  readonly templates = new Map<string, ActorTemplateSpec>();
  readonly actors = new Map<string, { state: ActorState; templateName: string }>();
  readonly egressPolicies = new Map<string, EgressRule[]>();
  constructor(private readonly options: { workers: number }) {}

  async ensureActorTemplate(spec: ActorTemplateSpec): Promise<void> {
    this.templates.set(`${spec.atespace}/${spec.name}`, structuredClone(spec));
  }
  async createActor(atespace: string, name: string, template: string): Promise<void> {
    const key = `${atespace}/${name}`;
    if (this.actors.has(key)) throw new SubstrateAlreadyExistsError(key);
    this.actors.set(key, { state: "SUSPENDED", templateName: template });
  }
  async getActor(atespace: string, name: string): Promise<ActorInfo | undefined> {
    const actor = this.actors.get(`${atespace}/${name}`);
    return actor ? { ...actor } : undefined;
  }
  async resumeActor(atespace: string, name: string): Promise<void> {
    const actor = this.actors.get(`${atespace}/${name}`);
    if (!actor) throw new SubstrateNotFoundError("substrate_not_found");
    if (actor.state === "RUNNING") return;
    const running = [...this.actors.values()].filter((a) => a.state === "RUNNING").length;
    if (running >= this.options.workers) throw new SubstrateExhaustedError("no worker has room");
    actor.state = "RUNNING";
  }
  async deleteActor(atespace: string, name: string): Promise<void> {
    this.actors.delete(`${atespace}/${name}`);
  }
  async putEgressPolicy(atespace: string, actor: string, rules: EgressRule[]): Promise<void> {
    this.egressPolicies.set(`${atespace}/${actor}`, structuredClone(rules));
  }
  async deleteEgressPolicy(atespace: string, actor: string): Promise<void> {
    this.egressPolicies.delete(`${atespace}/${actor}`);
  }
  async listWorkers(): Promise<WorkerInfo[]> {
    return Array.from({ length: this.options.workers }, () => ({
      pool: "fake",
      freeCpuMillicores: 1000,
      freeMemoryBytes: 2 ** 30,
    }));
  }
  /** Test hook: put an actor in a state (e.g. CRASHED). */
  setState(atespace: string, name: string, state: ActorState): void {
    const actor = this.actors.get(`${atespace}/${name}`);
    if (actor) actor.state = state;
  }
}
