# Phase 12 Plan 2a: Kubernetes Job Launcher for Codex, with a Local `kind` Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Codex coding agents as isolated Kubernetes pods driven by the control plane through the standard Kubernetes API, proven end to end on a local `kind` cluster: the launcher passes the existing `JobLauncher` contract suite, an isolation acceptance suite passes against a policy-enforcing cluster, and a real Codex run opens a draft PR.

**Architecture:** A new `KubernetesJobLauncher` implements the existing `WorkspaceJobLauncher` interface (`src/providers/jobs/types.ts`), exactly as `DockerJobLauncher` does, so `ContainerExecutor`, proxy sessions, the Git finalizer, validation, recovery and the Plan 1 concurrency queue are unchanged. Each run is one pod with two containers sharing a disk-backed `emptyDir`: a `keeper` (the worker image running `keeper.js`) and the `worker`, whose start is gated on a marker file the launcher writes after seeding and attestation. All job state lives in Kubernetes (a per-run record ConfigMap and a per-run capability Secret), never in control-plane files or timers, because any control-plane replica may call `status`/`collect`. The launcher talks to Kubernetes only through a narrow `KubernetesApi` seam, so every behavior is unit-tested against an in-memory fake and re-proven against a real `kind` cluster.

**Tech Stack:** TypeScript / Node 24, `@kubernetes/client-node` 2.x, `tar-stream` 3.x, Vitest, `kind` 0.33 (kindnet with its network-policy controller), kustomize (built into `kubectl`), Prisma 6 + PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-09-22-phase-12-kubernetes-job-launcher-design.md`. This is **Plan 2a of Phase 12** (Plan 1, foundations, is already on this branch). Plan 2b covers Claude Code's two-pod layout and the relay's move from a Unix socket to TCP; Plan 3 covers GKE.

## Global Constraints

- **Branch:** work on `phase-12-foundations` (Plan 1 is already there). Never commit to `main`.
- **No worker-image change in this plan.** The worker image, driver image, and their pinned digests are untouched. Everything the pod needs is expressed in the pod spec.
- **Spec corrections made while planning (binding for this plan; the spec is updated in Task 10):**
  1. _Diagnostics (user decision "A now, B later"):_ the control plane reads only a failed worker container's last 8 log lines (≤ 4096 bytes) through the Kubernetes API and keeps only a code matching the existing `SAFE_WORKER_DIAGNOSTIC` pattern; the raw text is never stored, logged, or returned. This replaces spec §7's "No `pods/log`". Later (not this plan): the worker writes `diagnostic.json` and the launcher prefers it.
  2. _Extractor:_ in-tree symlinks are allowed (today's `validateMaterializedWorkspace` allows them); the extractor rejects any entry whose path passes through an already-extracted symlink, plus absolute paths, `..`, hard links, and device/fifo/other special entries. This replaces spec §4's "rejects symlinks".
  3. _State:_ job state lives in a per-run ConfigMap (record) and a per-run Secret (capability); the deadline is also enforced by the pod's `activeDeadlineSeconds`. No local state files, no in-process timers.
  4. _Proxy addressing:_ workers keep `WARDBY_PROXY_URL=http://wardby-proxy:8787` (the proxy checks the `Host` header); the pod maps `wardby-proxy` to the proxy Service's ClusterIP with `hostAliases`, so no DNS is needed.
  5. _Start gate:_ the worker container's command is overridden to wait for `/run/wardby/input/.seeded` before importing `/opt/wardby/coding-worker/main.js` (native sidecars can't be used: Kubernetes terminates them when the main container exits, which would kill the keeper before collection).
- **Kubernetes object names:** namespace default `wardby-coding`; proxy Service `wardby-coding-proxy`; worker service account `wardby-coding-worker`; per-run objects named `wardby-run-<token>` where `<token>` is the first 20 hex characters of `sha256(runId)` (the capability Secret is `wardby-run-<token>-cap`).
- **Labels on every per-run object:** `app.kubernetes.io/managed-by: wardby`, `wardby.io/component: coding-run`, `wardby.io/run-sha256: <first 40 hex of sha256(runId)>`. Annotation `wardby.io/run-id: <runId>`.
- **Images must be registry digests** (`repo@sha256:<64 hex>`) in Kubernetes mode; bare `sha256:` local image IDs are rejected (a cluster cannot pull them).
- **Deploy rules (CLAUDE.md "Deployment (deploy/) — STRICT"):** no real credentials, project IDs, or test values in committed files; the `kind` harness reads secrets from `.env.local` at run time and never writes them to a tracked file.
- **Prisma rules (CLAUDE.md) apply to Task 9's migration.** The local database uses the pre-rename credentials `reevo`/`reevo` from `.env.local`; use them for the drift check. Do not run `npm run db:up` (it recreates the container).
- **Clean-room (CLEANROOM.md):** write everything from this plan, the spec, and the official Kubernetes / library documentation; copy no external code.
- **Verification for every code task:** `npm run typecheck`, `npm run lint`, `npm test`, `npm run format:check`. Tests needing a cluster are gated and skipped without one.
- **Commit messages end with** a `Co-Authored-By:` line naming the model that authored the commit, then `Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4`.

## File structure

| File                                                           | Responsibility                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/config/providers.ts` (modify)                             | `JobLauncherKind` gains `"kubernetes"` (replacing the unused `"ecs"`); `loadKubernetesJobConfig`.                        |
| `src/providers/jobs/kubernetes-api.ts` (new)                   | The narrow `KubernetesApi` seam and its error classes.                                                                   |
| `src/providers/jobs/fake-kubernetes-api.ts` (new)              | In-memory `KubernetesApi` for unit tests (like `fake.ts` for jobs).                                                      |
| `src/providers/jobs/kubernetes-client.ts` (new)                | `ClientNodeKubernetesApi`: the seam implemented with `@kubernetes/client-node`. Covered by the `kind` integration tests. |
| `src/providers/jobs/kubernetes-isolation.ts` (new)             | Canonical builders for the run pod, network policy, capability Secret, record ConfigMap; the attestation comparator.     |
| `src/providers/jobs/safe-extract.ts` (new)                     | Strict streaming tar extractor.                                                                                          |
| `src/providers/jobs/kubernetes.ts` (new)                       | `KubernetesJobLauncher`.                                                                                                 |
| `src/providers/jobs/kubernetes-preflight.ts` (new)             | Cluster preflight: namespace, proxy Service, network-policy enforcement canary.                                          |
| `src/providers/executor/composition.ts`, `src/cli.ts` (modify) | Select the launcher; `wardby coding preflight` for Kubernetes.                                                           |
| `deploy/kind-coding/` (new)                                    | `kind` cluster config, local registry, kustomize manifests (base + `kind` overlay), up/down scripts, README.             |
| `src/providers/jobs/kubernetes.integration.test.ts` (new)      | Gated tests against a real cluster: contract suite + isolation acceptance.                                               |
| Coding profile, dispatch, schema, migration (modify; Task 9)   | Per-agent workspace size (`workspaceDiskMb`).                                                                            |
| `docs/coding-worker-isolation.md`, the spec (modify; Task 10)  | Kubernetes launcher docs; spec corrections; smoke evidence.                                                              |

---

### Task 1: Configuration for the Kubernetes launcher

**Files:**

- Modify: `src/config/providers.ts` (`JobLauncherKind` line 10; add after `loadCodingConcurrencyConfig`)
- Modify: `src/config/providers.test.ts`
- Modify: `src/providers/index.ts` (comment on line 6 naming `jobs/ecs-fargate.ts`)
- Modify: `.env.example`

**Interfaces:** Produces:

```typescript
export type JobLauncherKind = "local" | "docker" | "kubernetes";
export interface KubernetesJobConfig {
  namespace: string; // KUBERNETES_NAMESPACE, default "wardby-coding"
  context?: string; // KUBERNETES_CONTEXT: kubeconfig context to use; unset = current context or in-cluster
  proxyService: string; // KUBERNETES_PROXY_SERVICE, default "wardby-coding-proxy"
  runtimeClassName?: string; // KUBERNETES_RUNTIME_CLASS, e.g. "gvisor"; unset = development cluster (warned)
}
export function loadKubernetesJobConfig(env?: NodeJS.ProcessEnv): KubernetesJobConfig;
```

- [ ] **Step 1: Write the failing tests**

In `src/config/providers.test.ts`, add `loadKubernetesJobConfig` to the import from `./providers.js` and append:

```typescript
describe("loadKubernetesJobConfig", () => {
  it("defaults to the wardby-coding namespace and proxy Service, with no context or runtime class", () => {
    expect(loadKubernetesJobConfig({})).toEqual({
      namespace: "wardby-coding",
      proxyService: "wardby-coding-proxy",
    });
  });

  it("reads every setting", () => {
    expect(
      loadKubernetesJobConfig({
        KUBERNETES_NAMESPACE: "coding-staging",
        KUBERNETES_CONTEXT: "kind-wardby",
        KUBERNETES_PROXY_SERVICE: "proxy",
        KUBERNETES_RUNTIME_CLASS: "gvisor",
      }),
    ).toEqual({
      namespace: "coding-staging",
      context: "kind-wardby",
      proxyService: "proxy",
      runtimeClassName: "gvisor",
    });
  });

  it.each(["", "Upper", "under_score", "-leading", "x".repeat(64)])("rejects KUBERNETES_NAMESPACE=%j", (value) => {
    expect(() => loadKubernetesJobConfig({ KUBERNETES_NAMESPACE: value })).toThrow(
      "KUBERNETES_NAMESPACE must be a DNS-1123 label.",
    );
  });

  it("rejects an invalid proxy Service name", () => {
    expect(() => loadKubernetesJobConfig({ KUBERNETES_PROXY_SERVICE: "Bad_Name" })).toThrow(
      "KUBERNETES_PROXY_SERVICE must be a DNS-1123 label.",
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/config/providers.test.ts -t loadKubernetesJobConfig`
Expected: FAIL (`loadKubernetesJobConfig is not a function`).

- [ ] **Step 3: Implement**

In `src/config/providers.ts`, change line 10 to:

```typescript
export type JobLauncherKind = "local" | "docker" | "kubernetes";
```

and add after `loadCodingConcurrencyConfig`:

```typescript
const DNS_1123_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function dnsLabel(value: string | undefined, name: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (!DNS_1123_LABEL.test(value)) throw new Error(`${name} must be a DNS-1123 label.`);
  return value;
}

/** JOB_LAUNCHER=kubernetes: where coding-run pods go and how they reach the in-cluster proxy. */
export interface KubernetesJobConfig {
  namespace: string;
  context?: string;
  proxyService: string;
  runtimeClassName?: string;
}

export function loadKubernetesJobConfig(env: NodeJS.ProcessEnv = process.env): KubernetesJobConfig {
  const config: KubernetesJobConfig = {
    namespace: dnsLabel(env.KUBERNETES_NAMESPACE, "KUBERNETES_NAMESPACE", "wardby-coding"),
    proxyService: dnsLabel(env.KUBERNETES_PROXY_SERVICE, "KUBERNETES_PROXY_SERVICE", "wardby-coding-proxy"),
  };
  if (env.KUBERNETES_CONTEXT) config.context = env.KUBERNETES_CONTEXT;
  if (env.KUBERNETES_RUNTIME_CLASS) {
    config.runtimeClassName = dnsLabel(env.KUBERNETES_RUNTIME_CLASS, "KUBERNETES_RUNTIME_CLASS", "");
  }
  return config;
}
```

In `src/providers/index.ts`, replace the phrase `` `jobs/ecs-fargate.ts` `` in the line-6 comment with `` `jobs/kubernetes.ts` ``.

In `.env.example`, after the `CODING_QUEUE_TIMEOUT_SEC` lines, add:

```dotenv
# JOB_LAUNCHER=kubernetes: coding runs as pods (see deploy/kind-coding/ locally).
# Namespace holding coding-run pods and the in-cluster coding proxy.
KUBERNETES_NAMESPACE=wardby-coding
# kubeconfig context to use; unset = current context, or in-cluster credentials.
KUBERNETES_CONTEXT=
KUBERNETES_PROXY_SERVICE=wardby-coding-proxy
# Required RuntimeClass for coding pods (e.g. gvisor on GKE). Unset = development
# cluster: the launcher logs a warning on every launch.
KUBERNETES_RUNTIME_CLASS=
```

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run src/config/providers.test.ts` then `npm run typecheck && npm run lint && npm test && npm run format:check`
Expected: all pass.

```bash
git add src/config/providers.ts src/config/providers.test.ts src/providers/index.ts .env.example
git commit -m "feat(config): add JOB_LAUNCHER=kubernetes and its settings

Replaces the reserved, never-used \"ecs\" launcher kind: AWS coding runs
will use the Kubernetes launcher on EKS. loadKubernetesJobConfig reads the
namespace, optional kubeconfig context, proxy Service name, and optional
required RuntimeClass, validating names as DNS-1123 labels."
```

(Append the two attribution trailer lines from Global Constraints to every commit message in this plan.)

---

### Task 2: The `KubernetesApi` seam, an in-memory fake, and the client-node adapter

**Files:**

- Modify: `package.json`, `package-lock.json` (dependencies)
- Create: `src/providers/jobs/kubernetes-api.ts`
- Create: `src/providers/jobs/fake-kubernetes-api.ts`
- Create: `src/providers/jobs/fake-kubernetes-api.test.ts`
- Create: `src/providers/jobs/kubernetes-client.ts`

**Interfaces:** Produces (everything later tasks use to reach Kubernetes):

```typescript
import type { V1ConfigMap, V1NetworkPolicy, V1Pod, V1Secret, V1Service } from "@kubernetes/client-node";
import type { Readable, Writable } from "node:stream";

export class KubernetesNotFoundError extends Error {}
export class KubernetesConflictError extends Error {} // stale resourceVersion on replace
export class KubernetesAlreadyExistsError extends Error {} // create of an existing name

export interface KubernetesExecOptions {
  stdin?: Readable;
  stdout?: Writable;
  timeoutMs: number;
}

export interface KubernetesApi {
  createConfigMap(namespace: string, body: V1ConfigMap): Promise<V1ConfigMap>;
  readConfigMap(namespace: string, name: string): Promise<V1ConfigMap | undefined>;
  replaceConfigMap(namespace: string, name: string, body: V1ConfigMap): Promise<V1ConfigMap>;
  createSecret(namespace: string, body: V1Secret): Promise<V1Secret>;
  deleteSecret(namespace: string, name: string): Promise<void>;
  createPod(namespace: string, body: V1Pod): Promise<V1Pod>;
  readPod(namespace: string, name: string): Promise<V1Pod | undefined>;
  deletePod(namespace: string, name: string, gracePeriodSeconds: number): Promise<void>;
  createNetworkPolicy(namespace: string, body: V1NetworkPolicy): Promise<V1NetworkPolicy>;
  readNetworkPolicy(namespace: string, name: string): Promise<V1NetworkPolicy | undefined>;
  deleteNetworkPolicy(namespace: string, name: string): Promise<void>;
  readService(namespace: string, name: string): Promise<V1Service | undefined>;
  readNamespace(name: string): Promise<boolean>;
  /** Runs a command in a container; resolves with its exit code. Never uses a shell. */
  exec(
    namespace: string,
    pod: string,
    container: string,
    command: string[],
    options: KubernetesExecOptions,
  ): Promise<number>;
  /** Reads at most `limitBytes` of the last `tailLines` lines of a container's log. */
  readLogTail(
    namespace: string,
    pod: string,
    container: string,
    tailLines: number,
    limitBytes: number,
  ): Promise<string>;
}
```

Deletes are idempotent (a missing object is not an error). Reads return `undefined` for a missing object.

- [ ] **Step 1: Add the dependencies**

Run: `npm install @kubernetes/client-node@^2.0.0 tar-stream@^3.2.1 && npm install --save-dev @types/tar-stream@^3.1.4`
Expected: `package.json` gains the three entries; `package-lock.json` updates.

- [ ] **Step 2: Write the seam**

Create `src/providers/jobs/kubernetes-api.ts` with exactly the interface, options type, and three error classes shown under **Interfaces** above, each class setting `this.name` to its class name in the constructor, and this header comment:

```typescript
/**
 * The only surface KubernetesJobLauncher uses to reach a cluster. Kept narrow
 * so every launcher behavior is unit-tested against FakeKubernetesApi and
 * re-proven against a real cluster by kubernetes.integration.test.ts.
 */
```

- [ ] **Step 3: Write the failing fake tests**

Create `src/providers/jobs/fake-kubernetes-api.test.ts`:

```typescript
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { FakeKubernetesApi } from "./fake-kubernetes-api.js";
import { KubernetesAlreadyExistsError, KubernetesConflictError } from "./kubernetes-api.js";

describe("FakeKubernetesApi", () => {
  it("creates, reads, and conflict-checks ConfigMap replacement by resourceVersion", async () => {
    const api = new FakeKubernetesApi();
    const created = await api.createConfigMap("ns", { metadata: { name: "a" }, data: { k: "1" } });
    await expect(api.createConfigMap("ns", { metadata: { name: "a" } })).rejects.toBeInstanceOf(
      KubernetesAlreadyExistsError,
    );
    const updated = await api.replaceConfigMap("ns", "a", { ...created, data: { k: "2" } });
    expect(updated.metadata?.resourceVersion).not.toBe(created.metadata?.resourceVersion);
    await expect(api.replaceConfigMap("ns", "a", { ...created, data: { k: "3" } })).rejects.toBeInstanceOf(
      KubernetesConflictError,
    );
    expect((await api.readConfigMap("ns", "a"))?.data).toEqual({ k: "2" });
  });

  it("treats deletes of missing objects as success and reads of missing objects as undefined", async () => {
    const api = new FakeKubernetesApi();
    await expect(api.deletePod("ns", "missing", 0)).resolves.toBeUndefined();
    await expect(api.deleteSecret("ns", "missing")).resolves.toBeUndefined();
    await expect(api.deleteNetworkPolicy("ns", "missing")).resolves.toBeUndefined();
    expect(await api.readPod("ns", "missing")).toBeUndefined();
  });

  it("routes exec through a per-container handler and returns its exit code", async () => {
    const api = new FakeKubernetesApi();
    api.onExec = async ({ container, command, stdout }) => {
      stdout?.end(`${container}:${command.join(" ")}`);
      return 0;
    };
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (c: Buffer) => chunks.push(c));
    expect(await api.exec("ns", "p", "keeper", ["echo", "hi"], { stdout: out, timeoutMs: 1000 })).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe("keeper:echo hi");
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run src/providers/jobs/fake-kubernetes-api.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 5: Implement the fake**

Create `src/providers/jobs/fake-kubernetes-api.ts`:

```typescript
import type { V1ConfigMap, V1NetworkPolicy, V1Pod, V1Secret, V1Service } from "@kubernetes/client-node";
import type { Readable, Writable } from "node:stream";
import {
  KubernetesAlreadyExistsError,
  KubernetesConflictError,
  KubernetesNotFoundError,
  type KubernetesApi,
  type KubernetesExecOptions,
} from "./kubernetes-api.js";

export interface FakeExecCall {
  namespace: string;
  pod: string;
  container: string;
  command: string[];
  stdin?: Readable;
  stdout?: Writable;
}

type Kind = "configmap" | "secret" | "pod" | "networkpolicy" | "service";
type Obj = { metadata?: { name?: string; namespace?: string; resourceVersion?: string } };

/** In-memory KubernetesApi for unit tests. Tests drive pod status and exec behavior directly. */
export class FakeKubernetesApi implements KubernetesApi {
  readonly objects = new Map<string, Obj>();
  readonly namespaces = new Set<string>(["wardby-coding"]);
  readonly execCalls: FakeExecCall[] = [];
  readonly deletedPods: Array<{ name: string; gracePeriodSeconds: number }> = [];
  /** Returns the exit code; write to stdout / read stdin as the command would. Default: exit 0, no output. */
  onExec: (call: FakeExecCall) => Promise<number> = async ({ stdout, stdin }) => {
    stdin?.resume();
    stdout?.end();
    return 0;
  };
  logs = new Map<string, string>();
  private version = 0;

  private key(kind: Kind, namespace: string, name: string): string {
    return `${kind}/${namespace}/${name}`;
  }

  private create<T extends Obj>(kind: Kind, namespace: string, body: T): T {
    const name = body.metadata?.name;
    if (!name) throw new Error("fake_name_required");
    const key = this.key(kind, namespace, name);
    if (this.objects.has(key)) throw new KubernetesAlreadyExistsError(key);
    const stored = structuredClone({
      ...body,
      metadata: { ...body.metadata, namespace, resourceVersion: String(++this.version) },
    }) as T;
    this.objects.set(key, stored);
    return structuredClone(stored);
  }

  private read<T extends Obj>(kind: Kind, namespace: string, name: string): T | undefined {
    const found = this.objects.get(this.key(kind, namespace, name));
    return found ? (structuredClone(found) as T) : undefined;
  }

  private delete(kind: Kind, namespace: string, name: string): void {
    this.objects.delete(this.key(kind, namespace, name));
  }

  /** Test helper: overwrite an object without a resourceVersion check (e.g. to set pod status). */
  put<T extends Obj>(kind: Kind, namespace: string, body: T): void {
    const name = body.metadata?.name as string;
    this.objects.set(this.key(kind, namespace, name), {
      ...structuredClone(body),
      metadata: { ...body.metadata, namespace, resourceVersion: String(++this.version) },
    });
  }

  async createConfigMap(namespace: string, body: V1ConfigMap) {
    return this.create("configmap", namespace, body);
  }
  async readConfigMap(namespace: string, name: string) {
    return this.read<V1ConfigMap>("configmap", namespace, name);
  }
  async replaceConfigMap(namespace: string, name: string, body: V1ConfigMap) {
    const key = this.key("configmap", namespace, name);
    const current = this.objects.get(key);
    if (!current) throw new KubernetesNotFoundError(key);
    if (body.metadata?.resourceVersion !== current.metadata?.resourceVersion) throw new KubernetesConflictError(key);
    const stored = structuredClone({
      ...body,
      metadata: { ...body.metadata, namespace, resourceVersion: String(++this.version) },
    });
    this.objects.set(key, stored);
    return structuredClone(stored);
  }
  async createSecret(namespace: string, body: V1Secret) {
    return this.create("secret", namespace, body);
  }
  async deleteSecret(namespace: string, name: string) {
    this.delete("secret", namespace, name);
  }
  async createPod(namespace: string, body: V1Pod) {
    return this.create("pod", namespace, body);
  }
  async readPod(namespace: string, name: string) {
    return this.read<V1Pod>("pod", namespace, name);
  }
  async deletePod(namespace: string, name: string, gracePeriodSeconds: number) {
    this.deletedPods.push({ name, gracePeriodSeconds });
    this.delete("pod", namespace, name);
  }
  async createNetworkPolicy(namespace: string, body: V1NetworkPolicy) {
    return this.create("networkpolicy", namespace, body);
  }
  async readNetworkPolicy(namespace: string, name: string) {
    return this.read<V1NetworkPolicy>("networkpolicy", namespace, name);
  }
  async deleteNetworkPolicy(namespace: string, name: string) {
    this.delete("networkpolicy", namespace, name);
  }
  async readService(namespace: string, name: string) {
    return this.read<V1Service>("service", namespace, name);
  }
  async readNamespace(name: string) {
    return this.namespaces.has(name);
  }
  async exec(namespace: string, pod: string, container: string, command: string[], options: KubernetesExecOptions) {
    const call: FakeExecCall = { namespace, pod, container, command, stdin: options.stdin, stdout: options.stdout };
    this.execCalls.push(call);
    return this.onExec(call);
  }
  async readLogTail(namespace: string, pod: string, container: string, tailLines: number, limitBytes: number) {
    const lines = (this.logs.get(`${namespace}/${pod}/${container}`) ?? "").split("\n").slice(-tailLines).join("\n");
    return Buffer.from(lines).subarray(0, limitBytes).toString();
  }
}
```

- [ ] **Step 6: Run the fake tests**

Run: `npx vitest run src/providers/jobs/fake-kubernetes-api.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Implement the client-node adapter**

Create `src/providers/jobs/kubernetes-client.ts`. It maps the seam onto `@kubernetes/client-node` 2.x. **Before writing, open `node_modules/@kubernetes/client-node/dist/index.d.ts` and the `CoreV1Api` / `NetworkingV1Api` / `Exec` declarations and use the exact method names and parameter shapes they declare** (2.x uses single-object parameters such as `createNamespacedPod({ namespace, body })`); the typecheck must pass against the installed version. Required behavior:

- Construction: `new ClientNodeKubernetesApi({ context?: string })` builds a `KubeConfig`: `loadFromDefault()`, then `setCurrentContext(context)` when given. (In a pod with a service account, `loadFromDefault` uses in-cluster credentials.)
- Error mapping: an API error with HTTP status 404 → `KubernetesNotFoundError` for writes; `undefined` for reads and `readNamespace` returns `false`; 409 on `create*` → `KubernetesAlreadyExistsError`; 409 on `replace*` → `KubernetesConflictError`. Read the status code from the thrown error as the installed version exposes it (inspect its error class in the `.d.ts`).
- `delete*`: pass `gracePeriodSeconds` for pods; swallow 404.
- `exec`: use the library's `Exec` class with `tty=false`, the given stdin/stdout (stderr discarded to a sink), and resolve with the exit code parsed from the `V1Status` passed to the status callback (`status === "Success"` → 0; otherwise the `ExitCode` cause, else 1). Enforce `timeoutMs` by closing the WebSocket and rejecting with `new Error("kubernetes_exec_timeout")`.
- `readLogTail`: `readNamespacedPodLog` with `container`, `tailLines`, `limitBytes`.

No unit test for this file (it is a thin mapping); Task 8's integration tests cover it against `kind`.

- [ ] **Step 8: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run format:check`
Expected: all pass.

```bash
git add package.json package-lock.json src/providers/jobs/kubernetes-api.ts src/providers/jobs/fake-kubernetes-api.ts src/providers/jobs/fake-kubernetes-api.test.ts src/providers/jobs/kubernetes-client.ts
git commit -m "feat(jobs): add a narrow KubernetesApi seam, a fake, and a client-node adapter"
```

---

### Task 3: Pod and network-policy builders, and the attestation comparator

**Files:**

- Create: `src/providers/jobs/kubernetes-isolation.ts`
- Create: `src/providers/jobs/kubernetes-isolation.test.ts`

**Interfaces:**

- Consumes: `JobSpec` (`./types.js`); `CODING_PROXY_ALIAS`, `CODING_PROXY_PORT`, `CODING_WORKER_UID`, `CODING_WORKER_GID`, `WORKER_STOP_GRACE_SECONDS` (`./docker-isolation.js`).
- Produces:

```typescript
export const KUBERNETES_ISOLATION_ERROR = "kubernetes_isolation_unsupported";
export const KUBERNETES_PROVIDER_UNSUPPORTED = "kubernetes_provider_unsupported";
export const KEEPER_CONTAINER = "keeper";
export const WORKER_CONTAINER = "worker";
export const STORAGE_ROOT = "/run/wardby/storage"; // keeper's view
export const KEEPER_SEEDED_MARKER = "/run/wardby/storage/input/.seeded";
export const PROXY_POD_LABEL = { "app.kubernetes.io/name": "wardby-coding-proxy" };
export interface KubernetesRunNames {
  token: string;
  runSha: string;
  pod: string;
  policy: string;
  record: string;
  secret: string;
}
export function kubernetesRunNames(runId: string): KubernetesRunNames;
export function runLabels(runId: string): Record<string, string>;
export function isRegistryDigest(image: string): boolean;
export function validateKubernetesSpec(spec: JobSpec): void;
export interface RunPodOptions {
  namespace: string;
  proxyIp: string;
  runtimeClassName?: string;
}
export function buildRunPod(spec: JobSpec, options: RunPodOptions): V1Pod;
export function buildRunNetworkPolicy(spec: JobSpec, namespace: string): V1NetworkPolicy;
export function buildCapabilitySecret(spec: JobSpec, namespace: string, capability: string): V1Secret;
export function assertRunPodMatches(actual: V1Pod, expected: V1Pod): void; // throws KUBERNETES_ISOLATION_ERROR
export function assertRunNetworkPolicyMatches(actual: V1NetworkPolicy, expected: V1NetworkPolicy): void;
```

Git metadata is **not** seeded into the pod (the Docker launcher copies it into the keeper, but nothing mounts it; the finalizer uses the control plane's own clone). This is a deliberate simplification: the worker never sees Git metadata either way.

- [ ] **Step 1: Write the failing tests**

Create `src/providers/jobs/kubernetes-isolation.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { V1Pod } from "@kubernetes/client-node";
import type { JobSpec } from "./types.js";
import {
  KUBERNETES_ISOLATION_ERROR,
  KUBERNETES_PROVIDER_UNSUPPORTED,
  assertRunNetworkPolicyMatches,
  assertRunPodMatches,
  buildCapabilitySecret,
  buildRunNetworkPolicy,
  buildRunPod,
  isRegistryDigest,
  kubernetesRunNames,
  runLabels,
  validateKubernetesSpec,
} from "./kubernetes-isolation.js";

const IMAGE = `localhost:5001/wardby-coding-worker@sha256:${"a".repeat(64)}`;
const spec: JobSpec = {
  kind: "coding-agent",
  runId: "run-k8s-1",
  provider: "codex",
  image: IMAGE,
  inputArtifact: "/tmp/input.json",
  timeoutSec: 900,
  limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
  labels: {},
};
const options = { namespace: "wardby-coding", proxyIp: "10.96.0.50" };
const pod = () => buildRunPod(spec, options);
const worker = (p: V1Pod) => p.spec!.containers.find((c) => c.name === "worker")!;
const keeper = (p: V1Pod) => p.spec!.containers.find((c) => c.name === "keeper")!;

describe("kubernetes run names and labels", () => {
  it("derives stable DNS-1123 names from the run ID hash", () => {
    const names = kubernetesRunNames(spec.runId);
    expect(names.token).toMatch(/^[a-f0-9]{20}$/);
    expect(names.pod).toBe(`wardby-run-${names.token}`);
    expect(names.secret).toBe(`wardby-run-${names.token}-cap`);
    expect(kubernetesRunNames(spec.runId)).toEqual(names);
    expect(runLabels(spec.runId)).toEqual({
      "app.kubernetes.io/managed-by": "wardby",
      "wardby.io/component": "coding-run",
      "wardby.io/run-sha256": names.runSha,
    });
    expect(names.runSha).toMatch(/^[a-f0-9]{40}$/);
  });
});

describe("validateKubernetesSpec", () => {
  it("accepts a registry-digest Codex spec", () => {
    expect(() => validateKubernetesSpec(spec)).not.toThrow();
    expect(isRegistryDigest(IMAGE)).toBe(true);
  });
  it("rejects a bare local image ID, which a cluster cannot pull", () => {
    expect(() => validateKubernetesSpec({ ...spec, image: `sha256:${"b".repeat(64)}` })).toThrow(
      KUBERNETES_ISOLATION_ERROR,
    );
  });
  it("rejects Claude Code until Plan 2b", () => {
    expect(() => validateKubernetesSpec({ ...spec, provider: "claude-code", toolImage: IMAGE })).toThrow(
      KUBERNETES_PROVIDER_UNSUPPORTED,
    );
  });
});

describe("buildRunPod", () => {
  it("never mounts a Kubernetes token, shares host namespaces, or restarts", () => {
    const s = pod().spec!;
    expect(s.automountServiceAccountToken).toBe(false);
    expect(s.serviceAccountName).toBe("wardby-coding-worker");
    expect(s.enableServiceLinks).toBe(false);
    expect([s.hostNetwork, s.hostPID, s.hostIPC, s.shareProcessNamespace]).toEqual([false, false, false, false]);
    expect(s.restartPolicy).toBe("Never");
    expect(s.activeDeadlineSeconds).toBe(900);
  });

  it("runs every container non-root, read-only, with no privileges or capabilities", () => {
    expect(pod().spec!.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      seccompProfile: { type: "RuntimeDefault" },
    });
    for (const c of pod().spec!.containers) {
      expect(c.securityContext).toEqual({
        allowPrivilegeEscalation: false,
        privileged: false,
        readOnlyRootFilesystem: true,
        runAsNonRoot: true,
        capabilities: { drop: ["ALL"] },
      });
    }
  });

  it("denies DNS and reaches the proxy only through a hostAlias", () => {
    const s = pod().spec!;
    expect(s.dnsPolicy).toBe("None");
    expect(s.dnsConfig).toEqual({ nameservers: ["127.0.0.1"] });
    expect(s.hostAliases).toEqual([{ ip: "10.96.0.50", hostnames: ["wardby-proxy"] }]);
    expect(worker(pod()).env).toEqual([
      { name: "WARDBY_PROXY_URL", value: "http://wardby-proxy:8787" },
      {
        name: "WARDBY_RUN_CAPABILITY",
        valueFrom: { secretKeyRef: { name: kubernetesRunNames(spec.runId).secret, key: "capability" } },
      },
    ]);
  });

  it("gives the worker the four storage areas and never Git metadata", () => {
    expect(worker(pod()).volumeMounts).toEqual([
      { name: "storage", mountPath: "/workspace", subPath: "workspace" },
      { name: "storage", mountPath: "/run/wardby/input", subPath: "input", readOnly: true },
      { name: "storage", mountPath: "/run/wardby/output", subPath: "output" },
      { name: "tmp", mountPath: "/tmp" },
      { name: "home", mountPath: "/home/wardby" },
    ]);
    expect(keeper(pod()).volumeMounts).toEqual([{ name: "storage", mountPath: "/run/wardby/storage" }]);
  });

  it("uses a disk-backed workspace sized by limits.diskMb and fixed resources", () => {
    const volumes = pod().spec!.volumes!;
    expect(volumes.find((v) => v.name === "storage")?.emptyDir).toEqual({ sizeLimit: "2048Mi" });
    expect(worker(pod()).resources).toEqual({
      requests: { cpu: "1", memory: "2048Mi" },
      limits: { cpu: "1", memory: "2048Mi" },
    });
  });

  it("gates the worker on the seeded marker before loading the worker entrypoint", () => {
    const command = worker(pod()).command!;
    expect(command.slice(0, 2)).toEqual(["node", "-e"]);
    expect(command[2]).toContain("/run/wardby/input/.seeded");
    expect(command[2]).toContain("/opt/wardby/coding-worker/main.js");
    expect(keeper(pod()).command).toEqual(["node", "/opt/wardby/coding-worker/keeper.js"]);
  });

  it("adds the runtime class only when configured", () => {
    expect(pod().spec!.runtimeClassName).toBeUndefined();
    expect(buildRunPod(spec, { ...options, runtimeClassName: "gvisor" }).spec!.runtimeClassName).toBe("gvisor");
  });
});

describe("buildRunNetworkPolicy", () => {
  it("allows no ingress and egress only to the proxy pods on the proxy port", () => {
    const policy = buildRunNetworkPolicy(spec, "wardby-coding");
    expect(policy.spec?.podSelector).toEqual({ matchLabels: runLabels(spec.runId) });
    expect(policy.spec?.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(policy.spec?.ingress).toEqual([]);
    expect(policy.spec?.egress).toEqual([
      {
        to: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "wardby-coding-proxy" } } }],
        ports: [{ protocol: "TCP", port: 8787 }],
      },
    ]);
  });
});

describe("buildCapabilitySecret", () => {
  it("holds only the capability, labeled for the run", () => {
    const secret = buildCapabilitySecret(spec, "wardby-coding", "rrp_capability_value_123456");
    expect(secret.metadata?.name).toBe(kubernetesRunNames(spec.runId).secret);
    expect(secret.metadata?.labels).toEqual(runLabels(spec.runId));
    expect(secret.stringData).toEqual({ capability: "rrp_capability_value_123456" });
  });
});

describe("assertRunPodMatches", () => {
  const expected = pod();
  const withApiDefaults = (p: V1Pod): V1Pod => {
    const c = structuredClone(p);
    c.spec!.schedulerName = "default-scheduler";
    c.spec!.containers = c.spec!.containers.map((x) => ({
      ...x,
      terminationMessagePath: "/dev/termination-log",
      imagePullPolicy: "IfNotPresent",
    }));
    c.spec!.containers[1]!.resources = {
      requests: { cpu: "1000m", memory: "2Gi" },
      limits: { cpu: "1000m", memory: "2Gi" },
    };
    return c;
  };

  it("accepts the expected pod and API defaults / normalized quantities", () => {
    expect(() => assertRunPodMatches(withApiDefaults(expected), expected)).not.toThrow();
  });

  const mutations: Array<[string, (p: V1Pod) => void]> = [
    ["missing runtime class", (p) => void (p.spec!.runtimeClassName = "runc")],
    ["token mounted", (p) => void (p.spec!.automountServiceAccountToken = true)],
    ["host network", (p) => void (p.spec!.hostNetwork = true)],
    ["privileged worker", (p) => void (worker(p).securityContext!.privileged = true)],
    ["added capability", (p) => void (worker(p).securityContext!.capabilities = { drop: ["ALL"], add: ["NET_RAW"] })],
    ["writable root", (p) => void (worker(p).securityContext!.readOnlyRootFilesystem = false)],
    [
      "injected sidecar",
      (p) => void p.spec!.containers.push({ name: "mesh-proxy", image: "mesh@sha256:" + "c".repeat(64) }),
    ],
    ["init container", (p) => void (p.spec!.initContainers = [{ name: "init", image: IMAGE }])],
    ["hostPath volume", (p) => void p.spec!.volumes!.push({ name: "host", hostPath: { path: "/" } })],
    ["extra env", (p) => void worker(p).env!.push({ name: "EXTRA", value: "1" })],
    ["different image", (p) => void (worker(p).image = `other@sha256:${"d".repeat(64)}`)],
    ["dns re-enabled", (p) => void (p.spec!.dnsPolicy = "ClusterFirst")],
    ["higher memory limit", (p) => void (worker(p).resources!.limits!.memory = "4096Mi")],
  ];
  it.each(mutations)("rejects %s", (_name, mutate) => {
    const actual = withApiDefaults(expected);
    if (_name === "missing runtime class") {
      const gv = buildRunPod(spec, { ...options, runtimeClassName: "gvisor" });
      const a = withApiDefaults(gv);
      mutate(a);
      expect(() => assertRunPodMatches(a, gv)).toThrow(KUBERNETES_ISOLATION_ERROR);
      return;
    }
    mutate(actual);
    expect(() => assertRunPodMatches(actual, expected)).toThrow(KUBERNETES_ISOLATION_ERROR);
  });
});

describe("assertRunNetworkPolicyMatches", () => {
  it("rejects a policy that gained an egress rule", () => {
    const expected = buildRunNetworkPolicy(spec, "wardby-coding");
    const actual = structuredClone(expected);
    actual.spec!.egress!.push({ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }] });
    expect(() => assertRunNetworkPolicyMatches(actual, expected)).toThrow(KUBERNETES_ISOLATION_ERROR);
    expect(() => assertRunNetworkPolicyMatches(structuredClone(expected), expected)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/providers/jobs/kubernetes-isolation.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/providers/jobs/kubernetes-isolation.ts`:

```typescript
/**
 * Canonical Kubernetes isolation policy for one Codex coding run, mirroring
 * docker-isolation.ts. Nothing else constructs run pods or policies; the
 * launcher reads every object back and attests it against these builders
 * before the worker is allowed to start (the seeded-marker gate).
 */
import { createHash } from "node:crypto";
import type { V1Container, V1NetworkPolicy, V1Pod, V1Secret } from "@kubernetes/client-node";
import type { JobSpec } from "./types.js";
import {
  CODING_PROXY_ALIAS,
  CODING_PROXY_PORT,
  CODING_WORKER_GID,
  CODING_WORKER_UID,
  WORKER_STOP_GRACE_SECONDS,
} from "./docker-isolation.js";

export const KUBERNETES_ISOLATION_ERROR = "kubernetes_isolation_unsupported";
export const KUBERNETES_PROVIDER_UNSUPPORTED = "kubernetes_provider_unsupported";
export const KEEPER_CONTAINER = "keeper";
export const WORKER_CONTAINER = "worker";
export const STORAGE_ROOT = "/run/wardby/storage";
export const KEEPER_SEEDED_MARKER = `${STORAGE_ROOT}/input/.seeded`;
export const PROXY_POD_LABEL = { "app.kubernetes.io/name": "wardby-coding-proxy" } as const;
const WORKER_SERVICE_ACCOUNT = "wardby-coding-worker";
const REGISTRY_DIGEST = /^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/;
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;

/** The worker waits for the launcher's seeded marker, then runs the image's normal entrypoint. */
const WORKER_GATE = [
  'const fs = require("node:fs");',
  'const marker = "/run/wardby/input/.seeded";',
  "(function wait() {",
  "  if (fs.existsSync(marker)) {",
  '    import("/opt/wardby/coding-worker/main.js").catch(() => { process.exitCode = 1; });',
  "  } else {",
  "    setTimeout(wait, 250);",
  "  }",
  "})();",
].join("\n");

function isolationError(): Error {
  return new Error(KUBERNETES_ISOLATION_ERROR);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface KubernetesRunNames {
  token: string;
  runSha: string;
  pod: string;
  policy: string;
  record: string;
  secret: string;
}

export function kubernetesRunNames(runId: string): KubernetesRunNames {
  if (!RUN_ID.test(runId)) throw isolationError();
  const digest = sha256(runId);
  const token = digest.slice(0, 20);
  const base = `wardby-run-${token}`;
  return { token, runSha: digest.slice(0, 40), pod: base, policy: base, record: base, secret: `${base}-cap` };
}

export function runLabels(runId: string): Record<string, string> {
  return {
    "app.kubernetes.io/managed-by": "wardby",
    "wardby.io/component": "coding-run",
    "wardby.io/run-sha256": kubernetesRunNames(runId).runSha,
  };
}

export function isRegistryDigest(image: string): boolean {
  return REGISTRY_DIGEST.test(image);
}

function inRange(value: number, min: number, max: number, integer: boolean): boolean {
  return Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
}

export function validateKubernetesSpec(spec: JobSpec): void {
  if (spec.kind !== "coding-agent" || !RUN_ID.test(spec.runId)) throw isolationError();
  if (spec.provider === "claude-code") throw new Error(KUBERNETES_PROVIDER_UNSUPPORTED);
  if (spec.provider !== undefined && spec.provider !== "codex") throw isolationError();
  if (spec.toolImage !== undefined || !isRegistryDigest(spec.image)) throw isolationError();
  const { cpus, memoryMb, pids, diskMb } = spec.limits;
  if (
    !inRange(cpus, 0.1, 32, false) ||
    !inRange(memoryMb, 128, 65_536, true) ||
    !inRange(pids, 16, 4_096, true) ||
    !inRange(diskMb, 64, 32_768, true) ||
    !inRange(spec.timeoutSec, 1, 86_400, true)
  ) {
    throw isolationError();
  }
}

function containerSecurity() {
  return {
    allowPrivilegeEscalation: false,
    privileged: false,
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    capabilities: { drop: ["ALL"] },
  };
}

export interface RunPodOptions {
  namespace: string;
  proxyIp: string;
  runtimeClassName?: string;
}

export function buildRunPod(spec: JobSpec, options: RunPodOptions): V1Pod {
  validateKubernetesSpec(spec);
  const names = kubernetesRunNames(spec.runId);
  const scratchMb = Math.max(16, Math.min(64, Math.floor(spec.limits.memoryMb / 8)));
  const keeper: V1Container = {
    name: KEEPER_CONTAINER,
    image: spec.image,
    command: ["node", "/opt/wardby/coding-worker/keeper.js"],
    securityContext: containerSecurity(),
    resources: { requests: { cpu: "250m", memory: "128Mi" }, limits: { cpu: "250m", memory: "128Mi" } },
    volumeMounts: [{ name: "storage", mountPath: STORAGE_ROOT }],
    readinessProbe: { exec: { command: ["test", "-d", `${STORAGE_ROOT}/output`] }, periodSeconds: 1 },
  };
  const worker: V1Container = {
    name: WORKER_CONTAINER,
    image: spec.image,
    command: ["node", "-e", WORKER_GATE],
    env: [
      { name: "WARDBY_PROXY_URL", value: `http://${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}` },
      { name: "WARDBY_RUN_CAPABILITY", valueFrom: { secretKeyRef: { name: names.secret, key: "capability" } } },
    ],
    securityContext: containerSecurity(),
    resources: {
      requests: { cpu: String(spec.limits.cpus), memory: `${spec.limits.memoryMb}Mi` },
      limits: { cpu: String(spec.limits.cpus), memory: `${spec.limits.memoryMb}Mi` },
    },
    volumeMounts: [
      { name: "storage", mountPath: "/workspace", subPath: "workspace" },
      { name: "storage", mountPath: "/run/wardby/input", subPath: "input", readOnly: true },
      { name: "storage", mountPath: "/run/wardby/output", subPath: "output" },
      { name: "tmp", mountPath: "/tmp" },
      { name: "home", mountPath: "/home/wardby" },
    ],
  };
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: names.pod,
      namespace: options.namespace,
      labels: runLabels(spec.runId),
      annotations: { "wardby.io/run-id": spec.runId },
    },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      serviceAccountName: WORKER_SERVICE_ACCOUNT,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      shareProcessNamespace: false,
      activeDeadlineSeconds: spec.timeoutSec,
      terminationGracePeriodSeconds: WORKER_STOP_GRACE_SECONDS,
      dnsPolicy: "None",
      dnsConfig: { nameservers: ["127.0.0.1"] },
      hostAliases: [{ ip: options.proxyIp, hostnames: [CODING_PROXY_ALIAS] }],
      ...(options.runtimeClassName ? { runtimeClassName: options.runtimeClassName } : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: CODING_WORKER_UID,
        runAsGroup: CODING_WORKER_GID,
        fsGroup: CODING_WORKER_GID,
        seccompProfile: { type: "RuntimeDefault" },
      },
      volumes: [
        { name: "storage", emptyDir: { sizeLimit: `${spec.limits.diskMb}Mi` } },
        { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: `${scratchMb}Mi` } },
        { name: "home", emptyDir: { medium: "Memory", sizeLimit: `${scratchMb}Mi` } },
      ],
      containers: [keeper, worker],
    },
  };
}

export function buildRunNetworkPolicy(spec: JobSpec, namespace: string): V1NetworkPolicy {
  const names = kubernetesRunNames(spec.runId);
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: names.policy, namespace, labels: runLabels(spec.runId) },
    spec: {
      podSelector: { matchLabels: runLabels(spec.runId) },
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: [
        {
          to: [{ podSelector: { matchLabels: { ...PROXY_POD_LABEL } } }],
          ports: [{ protocol: "TCP", port: CODING_PROXY_PORT }],
        },
      ],
    },
  };
}

export function buildCapabilitySecret(spec: JobSpec, namespace: string, capability: string): V1Secret {
  const names = kubernetesRunNames(spec.runId);
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: { name: names.secret, namespace, labels: runLabels(spec.runId) },
    stringData: { capability },
  };
}

/** Canonical CPU (millicores) and memory (bytes) so "1" == "1000m" and "2048Mi" == "2Gi". */
function quantity(value: unknown): string {
  const text = String(value);
  const match = /^([0-9.]+)(m|Ki|Mi|Gi|Ti)?$/.exec(text);
  if (!match) return text;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "m") return `${amount}m`;
  if (unit === undefined && text.includes(".")) return `${amount * 1000}m`;
  const factor = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 } as const;
  if (unit) return String(amount * factor[unit as keyof typeof factor]);
  return /^\d+$/.test(text) && Number(text) < 1024 ? `${amount * 1000}m` : text;
}

function resources(r: V1Container["resources"]) {
  const pick = (m?: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(m ?? {})
        .map(([k, v]) => [k, quantity(v)])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  return { requests: pick(r?.requests), limits: pick(r?.limits) };
}

/** The security-relevant view of a container; API-defaulted fields are deliberately excluded. */
function containerProjection(c: V1Container) {
  return {
    name: c.name,
    image: c.image,
    command: c.command ?? null,
    args: c.args ?? null,
    env: c.env ?? [],
    envFrom: c.envFrom ?? [],
    ports: c.ports ?? [],
    securityContext: {
      allowPrivilegeEscalation: c.securityContext?.allowPrivilegeEscalation ?? null,
      privileged: c.securityContext?.privileged ?? null,
      readOnlyRootFilesystem: c.securityContext?.readOnlyRootFilesystem ?? null,
      runAsNonRoot: c.securityContext?.runAsNonRoot ?? null,
      capabilities: {
        drop: c.securityContext?.capabilities?.drop ?? [],
        add: c.securityContext?.capabilities?.add ?? [],
      },
      runAsUser: c.securityContext?.runAsUser ?? null,
      seccompProfile: c.securityContext?.seccompProfile ?? null,
    },
    resources: resources(c.resources),
    volumeMounts: (c.volumeMounts ?? []).map((m) => ({
      name: m.name,
      mountPath: m.mountPath,
      subPath: m.subPath ?? null,
      readOnly: m.readOnly ?? false,
    })),
  };
}

function podProjection(p: V1Pod) {
  const s = p.spec;
  if (!s) throw isolationError();
  return {
    labels: p.metadata?.labels ?? {},
    restartPolicy: s.restartPolicy,
    automountServiceAccountToken: s.automountServiceAccountToken ?? true,
    serviceAccountName: s.serviceAccountName,
    enableServiceLinks: s.enableServiceLinks ?? true,
    hostNetwork: s.hostNetwork ?? false,
    hostPID: s.hostPID ?? false,
    hostIPC: s.hostIPC ?? false,
    shareProcessNamespace: s.shareProcessNamespace ?? false,
    activeDeadlineSeconds: s.activeDeadlineSeconds ?? null,
    dnsPolicy: s.dnsPolicy,
    dnsConfig: s.dnsConfig ?? null,
    hostAliases: s.hostAliases ?? [],
    runtimeClassName: s.runtimeClassName ?? null,
    securityContext: {
      runAsNonRoot: s.securityContext?.runAsNonRoot ?? null,
      runAsUser: s.securityContext?.runAsUser ?? null,
      runAsGroup: s.securityContext?.runAsGroup ?? null,
      fsGroup: s.securityContext?.fsGroup ?? null,
      seccompProfile: s.securityContext?.seccompProfile ?? null,
      sysctls: s.securityContext?.sysctls ?? [],
    },
    volumes: (s.volumes ?? []).map((v) => {
      const { name, emptyDir, ...other } = v;
      return {
        name,
        emptyDir: emptyDir ? { medium: emptyDir.medium ?? "", sizeLimit: quantity(emptyDir.sizeLimit) } : null,
        other: Object.keys(other).sort(),
      };
    }),
    initContainers: (s.initContainers ?? []).map(containerProjection),
    ephemeralContainers: (s.ephemeralContainers ?? []).length,
    containers: s.containers.map(containerProjection),
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function assertRunPodMatches(actual: V1Pod, expected: V1Pod): void {
  if (!sameJson(podProjection(actual), podProjection(expected))) throw isolationError();
}

export function assertRunNetworkPolicyMatches(actual: V1NetworkPolicy, expected: V1NetworkPolicy): void {
  const view = (p: V1NetworkPolicy) => ({
    podSelector: p.spec?.podSelector ?? null,
    policyTypes: p.spec?.policyTypes ?? [],
    ingress: p.spec?.ingress ?? [],
    egress: p.spec?.egress ?? [],
  });
  if (!sameJson(view(actual), view(expected))) throw isolationError();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/providers/jobs/kubernetes-isolation.test.ts`
Expected: PASS. If the quantity-normalization test for `"1000m"` vs `"1"` or `"2Gi"` vs `"2048Mi"` fails, fix `quantity()` (not the test): CPU must compare in millicores and memory in bytes.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run format:check`

```bash
git add src/providers/jobs/kubernetes-isolation.ts src/providers/jobs/kubernetes-isolation.test.ts
git commit -m "feat(jobs): canonical Kubernetes isolation policy and attestation for Codex runs"
```

---

### Task 4: Strict streaming tar extractor

**Files:**

- Create: `src/providers/jobs/safe-extract.ts`
- Create: `src/providers/jobs/safe-extract.test.ts`

**Interfaces:** Produces:

```typescript
export interface SafeExtractLimits {
  maxBytes: number;
  maxEntries: number;
}
/** Extracts an untrusted tar stream into an existing, empty `root`. Rejects with a fixed `extract_*` error code. */
export function safeExtract(source: Readable, root: string, limits: SafeExtractLimits): Promise<void>;
```

Error codes (the message of the thrown `Error`): `extract_path_invalid` (absolute, `..`, empty or NUL segment), `extract_special_entry` (hard link, device, fifo, or any type other than file / directory / symlink), `extract_symlink_escape` (absolute link target, or one resolving outside `root`), `extract_through_symlink` (any entry whose path passes through an already-extracted symlink), `extract_duplicate_entry` (a path extracted twice), `extract_size_limit`, `extract_entry_limit`.

File modes: only the executable bit survives (`0o755` if any execute bit is set in the header, else `0o644`); directories are `0o755`; ownership is never applied. Symlinks are created as-is (relative, in-tree). `validateMaterializedWorkspace` (existing, in `docker.ts`) still runs after extraction in Task 5.

- [ ] **Step 1: Write the failing tests**

Create `src/providers/jobs/safe-extract.test.ts`. Archives are built in memory with `tar-stream`'s `pack()`, so the tests don't depend on the host's `tar`:

```typescript
import { lstat, mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import { safeExtract } from "./safe-extract.js";

type Entry = {
  name: string;
  type?: "file" | "directory" | "symlink" | "link" | "fifo" | "character-device";
  body?: string;
  linkname?: string;
  mode?: number;
};

async function archive(entries: Entry[]): Promise<Readable> {
  const pack = tar.pack();
  for (const e of entries) {
    const header = { name: e.name, type: e.type ?? "file", mode: e.mode ?? 0o644, linkname: e.linkname };
    await new Promise<void>((resolveEntry, reject) =>
      pack.entry(header, e.type && e.type !== "file" ? undefined : (e.body ?? ""), (err) =>
        err ? reject(err) : resolveEntry(),
      ),
    );
  }
  pack.finalize();
  return pack as unknown as Readable;
}

const roots: string[] = [];
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wardby-extract-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
const limits = { maxBytes: 1024 * 1024, maxEntries: 100 };

describe("safeExtract", () => {
  it("extracts files, directories, executable bits, and in-tree symlinks", async () => {
    const dir = await root();
    await safeExtract(
      await archive([
        { name: "./", type: "directory" },
        { name: "./src/", type: "directory" },
        { name: "./src/a.txt", body: "hello" },
        { name: "./run.sh", body: "#!/bin/sh", mode: 0o755 },
        { name: "./link", type: "symlink", linkname: "src/a.txt" },
      ]),
      dir,
      limits,
    );
    expect(await readFile(join(dir, "src/a.txt"), "utf8")).toBe("hello");
    expect((await stat(join(dir, "run.sh"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(dir, "src/a.txt"))).mode & 0o777).toBe(0o644);
    expect(await readlink(join(dir, "link"))).toBe("src/a.txt");
  });

  const rejects: Array<[string, Entry[], string]> = [
    ["absolute path", [{ name: "/etc/passwd", body: "x" }], "extract_path_invalid"],
    ["parent traversal", [{ name: "../escape", body: "x" }], "extract_path_invalid"],
    ["nested traversal", [{ name: "a/../../escape", body: "x" }], "extract_path_invalid"],
    [
      "hard link",
      [
        { name: "a", body: "x" },
        { name: "b", type: "link", linkname: "a" },
      ],
      "extract_special_entry",
    ],
    ["fifo", [{ name: "pipe", type: "fifo" }], "extract_special_entry"],
    ["device", [{ name: "dev", type: "character-device" }], "extract_special_entry"],
    ["absolute symlink", [{ name: "l", type: "symlink", linkname: "/etc" }], "extract_symlink_escape"],
    ["escaping symlink", [{ name: "l", type: "symlink", linkname: "../../etc" }], "extract_symlink_escape"],
    [
      "write through a symlink",
      [
        { name: "sub/", type: "directory" },
        { name: "l", type: "symlink", linkname: "sub" },
        { name: "l/file", body: "x" },
      ],
      "extract_through_symlink",
    ],
    [
      "duplicate file",
      [
        { name: "a", body: "1" },
        { name: "a", body: "2" },
      ],
      "extract_duplicate_entry",
    ],
  ];
  it.each(rejects)("rejects %s", async (_label, entries, code) => {
    const dir = await root();
    await expect(safeExtract(await archive(entries), dir, limits)).rejects.toThrow(code);
  });

  it("enforces the byte limit while streaming", async () => {
    const dir = await root();
    await expect(
      safeExtract(await archive([{ name: "big", body: "x".repeat(2048) }]), dir, { maxBytes: 1024, maxEntries: 10 }),
    ).rejects.toThrow("extract_size_limit");
  });

  it("enforces the entry limit", async () => {
    const dir = await root();
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, body: "x" }));
    await expect(safeExtract(await archive(many), dir, { maxBytes: 1024, maxEntries: 3 })).rejects.toThrow(
      "extract_entry_limit",
    );
  });

  it("never writes outside the root when rejecting", async () => {
    const dir = await root();
    await expect(safeExtract(await archive([{ name: "../outside", body: "x" }]), dir, limits)).rejects.toThrow();
    await expect(lstat(join(dir, "..", "outside"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/providers/jobs/safe-extract.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/providers/jobs/safe-extract.ts`:

```typescript
/**
 * Extracts an untrusted tar stream (a worker's workspace, streamed out of the
 * keeper) into a trusted, empty staging directory. Every entry is checked
 * before anything touches disk; nothing is ever written through a symlink,
 * and file creation is exclusive (O_EXCL), so an entry can never replace or
 * follow something already there. validateMaterializedWorkspace runs after
 * this as a second, independent pass.
 */
import { createWriteStream } from "node:fs";
import { lstat, mkdir, symlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";

export interface SafeExtractLimits {
  maxBytes: number;
  maxEntries: number;
}

function fail(code: string): never {
  throw new Error(code);
}

/** "./a/b" -> "a/b"; "./" -> "" (the root itself). Rejects anything that could leave the root. */
function normalize(name: string): string {
  if (name.includes("\0") || name.startsWith("/")) fail("extract_path_invalid");
  let path = name.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (path === ".") path = "";
  if (path === "") return "";
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) fail("extract_path_invalid");
  return path;
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

export async function safeExtract(source: Readable, root: string, limits: SafeExtractLimits): Promise<void> {
  const base = resolve(root);
  const symlinks = new Set<string>();
  const seen = new Set<string>();
  let entries = 0;
  let bytes = 0;
  const extract = tar.extract();
  source.on("error", (err) => extract.destroy(err));
  source.pipe(extract);

  for await (const entry of extract) {
    const { header } = entry;
    entries += 1;
    if (entries > limits.maxEntries) {
      entry.resume();
      fail("extract_entry_limit");
    }
    const path = normalize(header.name);
    if (path === "") {
      entry.resume();
      continue;
    }
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i += 1) {
      if (symlinks.has(segments.slice(0, i).join("/"))) {
        entry.resume();
        fail("extract_through_symlink");
      }
    }
    if (seen.has(path)) {
      entry.resume();
      fail("extract_duplicate_entry");
    }
    seen.add(path);
    const target = resolve(base, path);
    if (!inside(base, target)) {
      entry.resume();
      fail("extract_path_invalid");
    }
    const parent = await lstat(dirname(target)).catch(() => undefined);
    if (parent && (parent.isSymbolicLink() || !parent.isDirectory())) {
      entry.resume();
      fail("extract_through_symlink");
    }

    switch (header.type) {
      case "directory": {
        entry.resume();
        await mkdir(target, { recursive: true, mode: 0o755 });
        const created = await lstat(target);
        if (created.isSymbolicLink() || !created.isDirectory()) fail("extract_through_symlink");
        break;
      }
      case "file":
      case "contiguous-file": {
        const size = header.size ?? 0;
        if (bytes + size > limits.maxBytes) {
          entry.resume();
          fail("extract_size_limit");
        }
        bytes += size;
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        const mode = (header.mode ?? 0) & 0o111 ? 0o755 : 0o644;
        await pipeline(entry, createWriteStream(target, { flags: "wx", mode }));
        break;
      }
      case "symlink": {
        entry.resume();
        const link = header.linkname ?? "";
        if (link === "" || link.startsWith("/") || !inside(base, resolve(dirname(target), link))) {
          fail("extract_symlink_escape");
        }
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await symlink(link, target);
        symlinks.add(path);
        break;
      }
      default:
        entry.resume();
        fail("extract_special_entry");
    }
  }
}
```

Implementation note for the executor: if a write fails with `EEXIST` (the `wx` flag), rethrow it as `extract_duplicate_entry`; `mkdir(..., { recursive: true })` on an intermediate path that is an already-extracted symlink is prevented by the ancestor check above, but also confirm in a test that `a` (symlink) then `a/b/c` (file) is rejected.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/providers/jobs/safe-extract.test.ts`
Expected: PASS. Every rejection case must fail with its exact code; if `tar-stream` normalizes a malicious name before your check sees it (for example stripping a leading `/`), assert against the raw header name instead and keep the test.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run format:check`

```bash
git add src/providers/jobs/safe-extract.ts src/providers/jobs/safe-extract.test.ts
git commit -m "feat(jobs): strict streaming tar extractor for untrusted worker workspaces"
```

---

### Task 5: `KubernetesJobLauncher`

**Files:**

- Create: `src/providers/jobs/kubernetes.ts`
- Create: `src/providers/jobs/kubernetes.test.ts`
- Create: `src/providers/jobs/workspace-swap.ts`
- Modify: `src/providers/jobs/docker.ts` (export `SAFE_WORKER_DIAGNOSTIC`; `NodeDockerArtifactTransfer.materializeDirectory` uses the new swap helper)

**Interfaces:**

- Consumes: Task 1 `KubernetesJobConfig`; Task 2 `KubernetesApi` + errors + `FakeKubernetesApi`; Task 3 builders, names, `KEEPER_CONTAINER`, `WORKER_CONTAINER`, `STORAGE_ROOT`, `KEEPER_SEEDED_MARKER`; Task 4 `safeExtract`; existing `validateMaterializedWorkspace` (`docker.ts`), `MAX_CODING_ARTIFACT_BYTES`, `parseCodingAgentOutputJson` (`../../coding/protocol.js`), `jobLauncherContract` (`./contract-suite.ts`).
- Produces:

```typescript
export interface KubernetesJobLauncherOptions {
  api: KubernetesApi;
  config: KubernetesJobConfig;
  workspaceRoot: string; // same root the VCS provider prepares workspaces under
  resolveCapability: (runId: string) => Promise<string>;
  /** Cluster preflight run once before the first launch; failure fails every launch (Task 6 supplies it). */
  preflight?: () => Promise<void>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  readyTimeoutMs?: number; // default 120_000
  createArchive?: (directory: string) => { stream: Readable; done: Promise<number> }; // default: host `tar`
  onWarning?: (message: string) => void;
}
export class KubernetesJobLauncher implements WorkspaceJobLauncher {
  /* launch, status, collect, materializeWorkspace, stop, remove */
}

// workspace-swap.ts
/** Fills a fresh staging directory next to `destination`, validates it, then atomically swaps it into place. */
export async function replaceDirectoryFromStaging(
  destination: string,
  maxBytes: number,
  destinationInvalidError: string,
  fill: (staging: string) => Promise<void>,
): Promise<void>;
```

Handles are `{ backend: "kubernetes", id: "<namespace>/<token>" }`. All state lives in the record ConfigMap (`data["record.json"]`: `{ schemaVersion: 1, runId, specHash, diskMb, createdAt, deadlineAt, phase, result? }`, phases `provisioning | active | succeeded | failed | stopped | lost | removed`), updated with `replaceConfigMap` + `resourceVersion` and retried on `KubernetesConflictError` (up to 5 times, then `kubernetes_record_conflict`). A removed run keeps its record as a tombstone, so `launch` returns the same handle and `status` still throws `job_removed` (contract: "never relaunches a removed run").

Behavior, mirroring `DockerJobLauncher` exactly where it has an equivalent:

- **launch(spec):** `validateKubernetesSpec`; run the memoized `preflight` (once per process; a failure throws `kubernetes_isolation_unsupported` for this and every later launch); stable spec hash (same algorithm as Docker's `stableSpecHash`: JSON of the spec with labels sorted); an existing record with a different hash → `job_spec_conflict`, same hash → return the handle. Otherwise create the record (`provisioning`, `deadlineAt = now + timeoutSec * 1000`; on `KubernetesAlreadyExistsError`, re-read and apply the same hash rule). Then: warn via `onWarning` when `config.runtimeClassName` is unset; resolve and validate the capability (`/^rrp_[A-Za-z0-9_-]{16,512}$/`, else `kubernetes_capability_invalid`); read the proxy Service (`clusterIP` required, else `kubernetes_proxy_unavailable`); create the capability Secret, the NetworkPolicy, and the Pod (`AlreadyExists` on any of them is not an error); wait for the keeper container to be `ready` (poll every 250 ms up to `readyTimeoutMs`; `ErrImagePull`, `ImagePullBackOff`, `InvalidImageName`, `CreateContainerConfigError`, `CreateContainerError`, or pod phase `Failed` → `kubernetes_pod_start_failed`; timeout → `kubernetes_pod_start_timeout`); **attest** the read-back Pod and NetworkPolicy with `assertRunPodMatches` / `assertRunNetworkPolicyMatches`; seed `workspaceRoot/<runId>/workspace` into `STORAGE_ROOT/workspace` and the input artifact (copied into a temp dir as `input.json`, validated as a regular file ≤ `MAX_CODING_ARTIFACT_BYTES`) into `STORAGE_ROOT/input`, each by piping `createArchive(dir).stream` into `exec(keeper, ["tar", "-C", <dest>, "--no-same-owner", "--no-same-permissions", "-xf", "-"])` (both exit codes must be 0, else `kubernetes_seed_failed`); write the marker with `exec(keeper, ["node", "-e", 'require("node:fs").writeFileSync("/run/wardby/storage/input/.seeded", "")'])`; set the record `active`; return the handle. On any failure after the record exists: delete the Pod (grace 0), NetworkPolicy, and Secret, set the record `failed` with `{ exitCode: 1, reason: "failed", diagnostic: "kubernetes_provisioning_failed" }`, and rethrow the original error.
- **Default `createArchive`:** `spawn("tar", ["-C", directory, "-cf", "-", "."], { shell: false, stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/local/bin:/usr/bin:/bin", COPYFILE_DISABLE: "1" } })` (`COPYFILE_DISABLE` stops macOS `tar` from adding `._*` metadata files); `done` resolves with the exit code.
- **Observing a non-terminal run (used by status/collect/remove):** no Pod → `lost` (unless the record is still `provisioning` and younger than `readyTimeoutMs`); `now >= deadlineAt` or `pod.status.reason === "DeadlineExceeded"` → delete the Pod (grace 10) and record `failed` with `{ exitCode: 124, reason: "timed_out" }`; worker container `terminated` with exit 0 → `succeeded` `{ exitCode: 0, reason: "completed" }`; terminated non-zero → `failed` `{ exitCode: reason === "OOMKilled" ? 137 : max(1, exitCode), reason: "failed" }`; pod phase `Failed` otherwise → `failed` `{ exitCode: 1, reason: "failed" }`; worker running or waiting → `active`. Never regress a terminal record (re-check inside the conflict-retrying update).
- **status:** unknown handle → `job_not_found`; removed → `job_removed`; otherwise observe and map exactly like Docker's `statusFor` (a `timed_out` failure reports `{ state: "failed", reason: "timed_out" }`).
- **collect:** removed → `job_removed`; observe; not terminal → `job_not_terminal`; fill the result from the phase if missing (Docker's `resultFor`: stopped `{143,"stopped"}`, lost `{1,"lost"}`); **failed without a diagnostic** → `readLogTail(worker, 8, 4096)`, scan lines from the end, `JSON.parse` each defensively, keep `error` only if it matches `SAFE_WORKER_DIAGNOSTIC` (never store, log, or return anything else from the log); any error reading the log (for example a pod already deleted after a timeout) is ignored, because diagnostics are optional exactly as in the Docker launcher; **succeeded without an artifact** → `exec(keeper, ["head", "-c", String(MAX_CODING_ARTIFACT_BYTES + 1), "/run/wardby/storage/output/result.json"])` into a bounded collector; over the limit or unparseable → `kubernetes_result_artifact_invalid`; `parseCodingAgentOutputJson` and a run-ID check (`kubernetes_result_run_mismatch`); store the JSON string as `resultArtifact`. Persist and return a copy.
- **materializeWorkspace(handle, destination):** phase must be `succeeded` (else `job_not_succeeded`); `destination` must resolve to exactly `workspaceRoot/<runId>/workspace` (else `kubernetes_workspace_destination_invalid`); `replaceDirectoryFromStaging(destination, record.diskMb * 1024 * 1024, "kubernetes_workspace_destination_invalid", fill)` where `fill(staging)` pipes `exec(keeper, ["tar", "-C", "/run/wardby/storage/workspace", "-cf", "-", "."])` stdout through a `PassThrough` into `safeExtract(stream, staging, { maxBytes, maxEntries: 100_000 })` (end the `PassThrough` when exec resolves; non-zero exit → `kubernetes_workspace_archive_failed`).
- **stop:** unknown/invalid handle → return; terminal → return; delete the Pod (grace 10); record `stopped` `{ exitCode: 143, reason: "stopped" }`.
- **remove:** unknown/invalid handle → return; removed → return; observe; not terminal → `job_not_terminal`; delete the Pod (grace 0), NetworkPolicy, and Secret; record `removed`.
- **Handles:** a handle whose backend isn't `kubernetes`, whose namespace isn't `config.namespace`, or whose token isn't 20 hex characters is treated as unknown.
- Always return `structuredClone`s (contract: defensive copies).

`workspace-swap.ts` is the staging/backup/rename logic currently inline in `NodeDockerArtifactTransfer.materializeDirectory` (the `realpath`/`lstat` destination checks, `mkdtemp` staging and backup beside the target, `validateMaterializedWorkspace`, rename-swap with rollback, cleanup in `finally`), moved verbatim into `replaceDirectoryFromStaging`, with the Docker `container cp` becoming the `fill` callback and `"docker_workspace_destination_invalid"` passed as the error. Docker's behavior and error strings are unchanged; its existing tests must pass untouched.

- [ ] **Step 1: Write the failing tests**

Create `src/providers/jobs/kubernetes.test.ts`. It runs the shared contract suite against the fake, plus launcher-specific tests:

```typescript
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { V1Pod } from "@kubernetes/client-node";
import tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import { jobLauncherContract } from "./contract-suite.js";
import { FakeKubernetesApi } from "./fake-kubernetes-api.js";
import { KubernetesJobLauncher } from "./kubernetes.js";
import { kubernetesRunNames } from "./kubernetes-isolation.js";
import type { JobHandle, JobSpec } from "./types.js";

const IMAGE = `localhost:5001/wardby-coding-worker@sha256:${"a".repeat(64)}`;
const CAPABILITY = `rrp_${"c".repeat(32)}`;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function harness(runId = "run-k8s-test", options: { runtimeClassName?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "wardby-k8s-launcher-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspaces");
  await mkdir(join(workspaceRoot, runId, "workspace"), { recursive: true });
  await writeFile(join(workspaceRoot, runId, "workspace", "README.md"), "hello\n");
  const inputArtifact = join(root, "input.json");
  await writeFile(inputArtifact, JSON.stringify({ runId }));
  const api = new FakeKubernetesApi();
  api.put("service", "wardby-coding", {
    metadata: { name: "wardby-coding-proxy" },
    spec: { clusterIP: "10.96.0.50" },
  });
  const names = kubernetesRunNames(runId);
  const spec: JobSpec = {
    kind: "coding-agent",
    runId,
    provider: "codex",
    image: IMAGE,
    inputArtifact,
    timeoutSec: 900,
    limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
    labels: {},
  };
  let now = 1_000_000;
  let result = JSON.stringify({ schemaVersion: 1, runId, outcome: "no_changes", summary: "done", tests: [] });
  const setPod = (mutate: (pod: V1Pod) => void) => {
    const pod = structuredClone(api.objects.get(`pod/wardby-coding/${names.pod}`)) as V1Pod | undefined;
    if (!pod) return;
    mutate(pod);
    api.put("pod", "wardby-coding", pod);
  };
  const keeperReady = () =>
    setPod((pod) => {
      pod.status = {
        phase: "Running",
        containerStatuses: [
          { name: "keeper", ready: true, image: IMAGE, imageID: IMAGE, restartCount: 0, state: { running: {} } },
          { name: "worker", ready: true, image: IMAGE, imageID: IMAGE, restartCount: 0, state: { running: {} } },
        ],
      };
    });
  // Fake kubelet: the pod becomes ready as soon as it exists.
  const originalCreatePod = api.createPod.bind(api);
  api.createPod = async (ns, body) => {
    const created = await originalCreatePod(ns, body);
    keeperReady();
    return created;
  };
  api.onExec = async ({ command, stdin, stdout }) => {
    stdin?.resume();
    if (command[0] === "head") stdout?.end(result);
    else stdout?.end();
    return 0;
  };
  const warnings: string[] = [];
  const launcher = new KubernetesJobLauncher({
    api,
    config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", ...options },
    workspaceRoot,
    resolveCapability: async () => CAPABILITY,
    now: () => now,
    sleep: async () => {},
    createArchive: () => ({ stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve(0) }),
    onWarning: (m) => warnings.push(m),
  });
  const finish = async (_handle: JobHandle, _r?: unknown) =>
    setPod((pod) => {
      pod.status!.containerStatuses![1]!.state = { terminated: { exitCode: 0, reason: "Completed" } };
    });
  const fail = (exitCode: number, reason = "Error") =>
    setPod((pod) => {
      pod.status!.containerStatuses![1]!.state = { terminated: { exitCode, reason } };
    });
  const lose = async (_handle: JobHandle) => api.deletePod("wardby-coding", names.pod, 0);
  return {
    api,
    launcher,
    spec,
    names,
    workspaceRoot,
    warnings,
    finish,
    fail,
    lose,
    advance: (ms: number) => void (now += ms),
    setResult: (value: string) => void (result = value),
  };
}

jobLauncherContract("Kubernetes", async () => {
  const h = await harness();
  return { launcher: h.launcher, spec: h.spec, finish: h.finish, lose: h.lose };
});

describe("KubernetesJobLauncher", () => {
  it("creates the attested pod, policy, and secret, seeds the keeper, then opens the gate", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    expect(handle).toEqual({ backend: "kubernetes", id: `wardby-coding/${h.names.token}` });
    expect(await h.api.readNetworkPolicy("wardby-coding", h.names.policy)).toBeDefined();
    expect(h.api.objects.has(`secret/wardby-coding/${h.names.secret}`)).toBe(true);
    const commands = h.api.execCalls.map((c) => c.command.join(" "));
    expect(commands[0]).toContain("tar -C /run/wardby/storage/workspace");
    expect(commands[1]).toContain("tar -C /run/wardby/storage/input");
    expect(commands[2]).toContain("/run/wardby/storage/input/.seeded");
    expect(h.api.execCalls.every((c) => c.container === "keeper")).toBe(true);
    expect(await h.launcher.status(handle)).toEqual({ state: "running" });
  });

  it("warns on every launch when no runtime class is configured", async () => {
    const h = await harness();
    await h.launcher.launch(h.spec);
    expect(h.warnings.join("\n")).toMatch(/runtime class/i);
    const g = await harness("run-gvisor", { runtimeClassName: "gvisor" });
    await g.launcher.launch(g.spec);
    expect(g.warnings).toEqual([]);
  });

  it("fails closed and cleans up when attestation finds a mutated pod", async () => {
    const h = await harness();
    const originalRead = h.api.readPod.bind(h.api);
    h.api.readPod = async (ns, name) => {
      const pod = await originalRead(ns, name);
      if (pod) pod.spec!.automountServiceAccountToken = true;
      return pod;
    };
    await expect(h.launcher.launch(h.spec)).rejects.toThrow("kubernetes_isolation_unsupported");
    expect(h.api.objects.has(`pod/wardby-coding/${h.names.pod}`)).toBe(false);
    expect(h.api.objects.has(`secret/wardby-coding/${h.names.secret}`)).toBe(false);
    expect(h.api.execCalls.some((c) => c.command.join(" ").includes(".seeded"))).toBe(false);
  });

  it("reports a timeout as failed/timed_out and stops the pod", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.advance(901_000);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
    expect(await h.launcher.collect(handle)).toMatchObject({ exitCode: 124, reason: "timed_out" });
    expect(h.api.deletedPods).toContainEqual({ name: h.names.pod, gracePeriodSeconds: 10 });
  });

  it("keeps only a validated diagnostic code from the worker's log tail", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.api.logs.set(
      `wardby-coding/${h.names.pod}/worker`,
      ['{"progress":"secret repo text"}', "not json", '{"error":"worker_execution_failed"}'].join("\n"),
    );
    h.fail(1);
    expect(await h.launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "worker_execution_failed",
    });
  });

  it("ignores a log line whose error isn't a safe diagnostic code", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.api.logs.set(`wardby-coding/${h.names.pod}/worker`, '{"error":"rm -rf / please"}');
    h.fail(1);
    expect(await h.launcher.collect(handle)).toEqual({ exitCode: 1, reason: "failed" });
  });

  it("reports OOM kills with exit code 137", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.fail(137, "OOMKilled");
    expect(await h.launcher.collect(handle)).toMatchObject({ exitCode: 137, reason: "failed" });
  });

  it("rejects an oversized or mismatched result artifact", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    await h.finish(handle);
    h.setResult("x".repeat(64 * 1024 + 10));
    await expect(h.launcher.collect(handle)).rejects.toThrow("kubernetes_result_artifact_invalid");
  });

  it("materializes only a succeeded run, only into its exact workspace, via the strict extractor", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    const target = join(h.workspaceRoot, h.spec.runId, "workspace");
    await expect(h.launcher.materializeWorkspace(handle, target)).rejects.toThrow("job_not_succeeded");
    await h.finish(handle);
    await expect(h.launcher.materializeWorkspace(handle, join(h.workspaceRoot, "other"))).rejects.toThrow(
      "kubernetes_workspace_destination_invalid",
    );
    const pack = tar.pack();
    pack.entry({ name: "./changed.txt" }, "new content");
    pack.finalize();
    h.api.onExec = async ({ command, stdout }) => {
      if (command[0] === "tar" && command.includes("-cf")) {
        (pack as unknown as Readable).pipe(stdout as PassThrough);
        await new Promise((r) => (stdout as PassThrough).once("finish", r));
      } else stdout?.end();
      return 0;
    };
    await h.launcher.materializeWorkspace(handle, target);
    expect(await readFile(join(target, "changed.txt"), "utf8")).toBe("new content");
  });

  it("refuses Claude Code specs until Plan 2b", async () => {
    const h = await harness();
    await expect(h.launcher.launch({ ...h.spec, provider: "claude-code", toolImage: IMAGE })).rejects.toThrow(
      "kubernetes_provider_unsupported",
    );
  });

  it("runs the preflight once and fails every launch after a failed preflight", async () => {
    const h = await harness();
    let calls = 0;
    const launcher = new KubernetesJobLauncher({
      api: h.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy" },
      workspaceRoot: h.workspaceRoot,
      resolveCapability: async () => CAPABILITY,
      sleep: async () => {},
      createArchive: () => ({ stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve(0) }),
      preflight: async () => {
        calls += 1;
        throw new Error("canary_reached_internet");
      },
    });
    await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_isolation_unsupported");
    await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_isolation_unsupported");
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/providers/jobs/kubernetes.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `workspace-swap.ts` and refactor Docker to use it**

Move the swap logic out of `NodeDockerArtifactTransfer.materializeDirectory` into `replaceDirectoryFromStaging` as described under **Interfaces**, and make `materializeDirectory` call it with the `container cp` as `fill`. Also change `const SAFE_WORKER_DIAGNOSTIC` in `docker.ts` to `export const SAFE_WORKER_DIAGNOSTIC`. Run: `npx vitest run src/providers/jobs/docker.test.ts` — expected: PASS unchanged.

- [ ] **Step 4: Implement the launcher**

Create `src/providers/jobs/kubernetes.ts` implementing every behavior listed under **Interfaces**. Structure it as: module constants (`BACKEND = "kubernetes"`, `STOP_GRACE_SECONDS = 10`, `DIAGNOSTIC_TAIL_LINES = 8`, `DIAGNOSTIC_LIMIT_BYTES = 4096`, `MAX_WORKSPACE_ENTRIES = 100_000`, the fatal-waiting-reason set, the capability and token regexes); pure helpers (`stableSpecHash`, `statusFor`, `resultFor`, `isTerminal`, `namesForToken(token)` returning the pod/policy/record/secret names, `parseRecord`, `observePod(pod, record, now, readyTimeoutMs)` returning the next phase/result and whether to delete the pod for a timeout); a bounded stdout collector; `hostTarArchive(directory)`; then the class with private `recordFor(handle)`, `updateRecord(recordName, mutate)` (conflict-retrying, never regressing a terminal phase), `refresh`, `waitForKeeper`, `seedDirectory`, `seedInput`, `cleanupRun`, and the six public methods. Keep each method short; put the lifecycle rules in the pure helpers so they are testable and readable. File header comment: why state lives in Kubernetes (any replica may observe a run) and why the gate exists (containers in a pod start together).

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/providers/jobs/kubernetes.test.ts src/providers/jobs/docker.test.ts`
Expected: PASS — the full shared contract suite ("Kubernetes JobLauncher contract", 11 tests) plus the launcher tests, and Docker unchanged.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run format:check`

```bash
git add src/providers/jobs/kubernetes.ts src/providers/jobs/kubernetes.test.ts src/providers/jobs/workspace-swap.ts src/providers/jobs/docker.ts
git commit -m "feat(jobs): add KubernetesJobLauncher for Codex runs

Implements WorkspaceJobLauncher on Kubernetes and passes the shared
JobLauncher contract suite. Each run is one pod (keeper + gated worker)
with its own NetworkPolicy and capability Secret; all job state lives in a
per-run record ConfigMap updated with optimistic concurrency, so any
control-plane replica can observe, collect, or remove a run. Pods are
attested against the canonical builders before the worker's start gate
opens; diagnostics come only from a bounded, pattern-validated read of a
failed worker's log tail. The Docker launcher's workspace swap is extracted
into a shared helper, unchanged in behavior."
```

---

### Task 6: Cluster preflight, composition, and the CLI

**Files:**

- Create: `src/providers/jobs/kubernetes-preflight.ts`
- Create: `src/providers/jobs/kubernetes-preflight.test.ts`
- Modify: `src/providers/executor/composition.ts`
- Modify: `src/providers/executor/composition.test.ts` (if it exists; otherwise create it)
- Modify: `src/cli.ts` (`codingOps`, usage text)

**Interfaces:**

- Consumes: Tasks 1–5.
- Produces:

```typescript
export interface KubernetesPreflightOptions {
  api: KubernetesApi;
  config: KubernetesJobConfig;
  workerImage: string; // registry digest
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number; // default 90_000
}
export interface CanaryResult {
  dns: boolean;
  internet: boolean;
  metadata: boolean;
  proxy: boolean;
}
/** Throws kubernetes_isolation_unsupported:<check> on the first failed check; returns the checks that passed. */
export async function kubernetesPreflight(options: KubernetesPreflightOptions): Promise<string[]>;
```

Checks, in order: `namespace` (exists), `proxy-service` (has a `clusterIP`), `worker-image` (registry digest), `canary` — a pod built with `buildRunPod` for a synthetic spec (`runId: "preflight-<random hex>"`, the worker image, minimal limits) with the `keeper` container removed, the worker's `env` replaced by `[{ name: "WARDBY_CANARY_PROXY_IP", value: <clusterIP> }]`, and its `command` replaced by `["node", "-e", CANARY_SCRIPT]`, plus the synthetic run's `buildRunNetworkPolicy`. It waits for the canary container to terminate (bounded by `timeoutMs`), reads its log tail (20 lines, 4096 bytes), finds the line `{"wardbyCanary":{...}}`, and requires **exactly** `{ dns: false, internet: false, metadata: false, proxy: true }`. The canary pod and policy are always deleted in `finally`. `CANARY_SCRIPT`:

```javascript
const net = require("node:net");
const dns = require("node:dns").promises;
const tcp = (host, port) =>
  new Promise((done) => {
    const socket = net.connect({ host, port, timeout: 3000 });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", () => done(false));
  });
(async () => {
  const wardbyCanary = {
    dns: await dns.lookup("kubernetes.default.svc.cluster.local").then(
      () => true,
      () => false,
    ),
    internet: await tcp("1.1.1.1", 443),
    metadata: await tcp("169.254.169.254", 80),
    proxy: await tcp(process.env.WARDBY_CANARY_PROXY_IP, 8787),
  };
  console.log(JSON.stringify({ wardbyCanary }));
})();
```

(The canary's own output is trusted: it is our script in our image. It still only parses the one fixed line.)

- [ ] **Step 1: Write the failing preflight tests**

Create `src/providers/jobs/kubernetes-preflight.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { V1Pod } from "@kubernetes/client-node";
import { FakeKubernetesApi } from "./fake-kubernetes-api.js";
import { kubernetesPreflight, type CanaryResult } from "./kubernetes-preflight.js";

const IMAGE = `localhost:5001/wardby-coding-worker@sha256:${"a".repeat(64)}`;
const config = { namespace: "wardby-coding", proxyService: "wardby-coding-proxy" };

function cluster(canary: CanaryResult | "no-output") {
  const api = new FakeKubernetesApi();
  api.put("service", "wardby-coding", { metadata: { name: "wardby-coding-proxy" }, spec: { clusterIP: "10.96.0.50" } });
  const originalCreate = api.createPod.bind(api);
  api.createPod = async (ns, body: V1Pod) => {
    const created = await originalCreate(ns, body);
    const name = body.metadata!.name!;
    api.put("pod", ns, {
      ...body,
      status: {
        phase: "Succeeded",
        containerStatuses: [
          {
            name: "worker",
            ready: false,
            image: IMAGE,
            imageID: IMAGE,
            restartCount: 0,
            state: { terminated: { exitCode: 0 } },
          },
        ],
      },
    });
    if (canary !== "no-output") api.logs.set(`${ns}/${name}/worker`, JSON.stringify({ wardbyCanary: canary }));
    return created;
  };
  return api;
}
const ok: CanaryResult = { dns: false, internet: false, metadata: false, proxy: true };

describe("kubernetesPreflight", () => {
  it("passes every check on an enforcing cluster and cleans up the canary", async () => {
    const api = cluster(ok);
    expect(await kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {} })).toEqual([
      "namespace",
      "proxy-service",
      "worker-image",
      "canary",
    ]);
    expect([...api.objects.keys()].filter((k) => k.startsWith("pod/") || k.startsWith("networkpolicy/"))).toEqual([]);
  });

  it.each([
    ["internet reachable", { ...ok, internet: true }],
    ["metadata reachable", { ...ok, metadata: true }],
    ["dns resolves", { ...ok, dns: true }],
    ["proxy unreachable", { ...ok, proxy: false }],
  ])("fails closed when %s", async (_label, result) => {
    await expect(
      kubernetesPreflight({ api: cluster(result), config, workerImage: IMAGE, sleep: async () => {} }),
    ).rejects.toThrow("kubernetes_isolation_unsupported:canary");
  });

  it("fails when the canary prints nothing", async () => {
    await expect(
      kubernetesPreflight({ api: cluster("no-output"), config, workerImage: IMAGE, sleep: async () => {} }),
    ).rejects.toThrow("kubernetes_isolation_unsupported:canary");
  });

  it("fails on a missing namespace, a missing proxy Service, or a local image ID", async () => {
    const noNs = cluster(ok);
    noNs.namespaces.clear();
    await expect(kubernetesPreflight({ api: noNs, config, workerImage: IMAGE })).rejects.toThrow(
      "kubernetes_isolation_unsupported:namespace",
    );
    const noProxy = cluster(ok);
    noProxy.objects.delete("service/wardby-coding/wardby-coding-proxy");
    await expect(kubernetesPreflight({ api: noProxy, config, workerImage: IMAGE })).rejects.toThrow(
      "kubernetes_isolation_unsupported:proxy-service",
    );
    await expect(
      kubernetesPreflight({ api: cluster(ok), config, workerImage: `sha256:${"b".repeat(64)}` }),
    ).rejects.toThrow("kubernetes_isolation_unsupported:worker-image");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/providers/jobs/kubernetes-preflight.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the preflight**

Create `src/providers/jobs/kubernetes-preflight.ts` as specified under **Interfaces** (a thrown check failure is `new Error(\`kubernetes_isolation_unsupported:${check}\`)`; poll the canary pod every 500 ms; `finally` deletes the canary pod with grace 0 and its NetworkPolicy).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/providers/jobs/kubernetes-preflight.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the launcher into composition**

In `src/providers/executor/composition.ts`:

(a) Add imports: `loadKubernetesJobConfig` (from `../../config/providers.js`), `KubernetesJobLauncher` (`../jobs/kubernetes.js`), `ClientNodeKubernetesApi` (`../jobs/kubernetes-client.js`), `kubernetesPreflight` (`../jobs/kubernetes-preflight.js`), `isRegistryDigest` (`../jobs/kubernetes-isolation.js`), and `type WorkspaceJobLauncher` (`../jobs/types.js`).

(b) Replace `if (providerConfig.jobs !== "docker") return options.native;` with `if (providerConfig.jobs !== "docker" && providerConfig.jobs !== "kubernetes") return options.native;`, keep the `CODING_WORKER_IMAGE` requirement for both, and require `CODING_PROXY_CONTAINER` only for Docker.

(c) Build `jobs` by launcher kind:

```typescript
let jobs: WorkspaceJobLauncher;
if (providerConfig.jobs === "kubernetes") {
  if (!isRegistryDigest(config.workerImage)) {
    throw new Error("CODING_WORKER_IMAGE must be a registry digest (repo@sha256:...) when JOB_LAUNCHER=kubernetes.");
  }
  const kubernetes = loadKubernetesJobConfig(env);
  const api = new ClientNodeKubernetesApi({ context: kubernetes.context });
  const workerImage = config.workerImage;
  jobs = new KubernetesJobLauncher({
    api,
    config: kubernetes,
    workspaceRoot,
    resolveCapability: (runId) => capabilities.get(runId),
    preflight: async () => {
      await kubernetesPreflight({ api, config: kubernetes, workerImage });
    },
    onWarning: (message) => compositionLog.warn(message),
  });
} else {
  jobs = new DockerJobLauncher({/* the existing Docker options, unchanged */});
}
```

(`stateRoot` stays Docker-only.) Everything after — `ContainerExecutor`, the cap, `onSlotReleased` — is unchanged and uses `jobs`.

Add a composition test (in the existing composition test file, or a new `composition.test.ts`) asserting: with `JOB_LAUNCHER=kubernetes` and a bare `sha256:` image, `buildConfiguredExecutor` throws the registry-digest error; with `JOB_LAUNCHER=kubernetes` and a registry digest (no `CODING_PROXY_CONTAINER`), it returns a routing executor without throwing (construction does not contact the cluster; `KubeConfig.loadFromDefault()` must not throw in the test environment — if it does, inject a fake via an optional `kubernetesApi` field on `ConfiguredExecutorOptions` used only by tests).

- [ ] **Step 6: The CLI**

In `src/cli.ts` `codingOps`: accept `JOB_LAUNCHER=kubernetes` as well as `docker` (update the error to `coding operations require JOB_LAUNCHER=docker or kubernetes.`). For `preflight` under Kubernetes, run `kubernetesPreflight` with a `ClientNodeKubernetesApi` and print `coding preflight passed (<checks joined by ", ">) for <image>`; keep the Docker path unchanged. `cleanup` already works for both through the executor. Update the usage text line for `wardby coding preflight` to `(JOB_LAUNCHER=docker or kubernetes)`.

- [ ] **Step 7: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run format:check`

```bash
git add src/providers/jobs/kubernetes-preflight.ts src/providers/jobs/kubernetes-preflight.test.ts src/providers/executor/composition.ts src/providers/executor/composition.test.ts src/cli.ts
git commit -m "feat: select the Kubernetes launcher with JOB_LAUNCHER=kubernetes; add cluster preflight

The preflight proves the namespace, the proxy Service, a registry-digest
worker image, and - with a canary pod under the real run policy - that DNS,
the internet, and the metadata server are unreachable while the proxy is
reachable. The launcher runs it once before its first launch and fails
closed; wardby coding preflight runs it on demand."
```

---

### Task 7: The local `kind` harness (`deploy/kind-coding/`)

**Files (all new):**

- `deploy/kind-coding/README.md`
- `deploy/kind-coding/kind-config.yaml`
- `deploy/kind-coding/up.sh`, `deploy/kind-coding/down.sh` (executable)
- `deploy/kind-coding/manifests/base/kustomization.yaml`
- `deploy/kind-coding/manifests/base/namespace.yaml`
- `deploy/kind-coding/manifests/base/service-accounts.yaml`
- `deploy/kind-coding/manifests/base/default-deny.yaml`
- `deploy/kind-coding/manifests/base/proxy.yaml` (Deployment + Service + NetworkPolicy)
- `deploy/kind-coding/manifests/base/launcher-role.yaml` (namespace Role for the control plane; bound per cloud in overlays)
- `deploy/kind-coding/manifests/base/quota.yaml`
- `deploy/kind-coding/manifests/overlays/kind/kustomization.yaml`
- `deploy/kind-coding/manifests/overlays/kind/proxy-database-egress.yaml`

**Interfaces:** Produces a running local cluster named `wardby` (context `kind-wardby`) with namespace `wardby-coding`, the in-cluster coding proxy Service `wardby-coding-proxy` on port 8787, a local registry at `localhost:5001`, and printed `.env.local` lines (`JOB_LAUNCHER=kubernetes`, `KUBERNETES_CONTEXT=kind-wardby`, `CODING_WORKER_IMAGE=localhost:5001/wardby-coding-worker@sha256:…`). Tasks 8 and 10 consume it. The manifests base is reused by Plan 3's GKE overlay.

No real credentials, digests, or IPs are committed: `up.sh` reads `.env.local` at run time, creates the proxy's Secret directly in the cluster, and substitutes image digests into the rendered manifests on the fly (never editing tracked files).

- [ ] **Step 1: Cluster config**

`kind-config.yaml`:

```yaml
# Local coding-run cluster. kindnet (kind's default network layer) enforces
# NetworkPolicy through its bundled kube-network-policies controller in
# current kind releases; `wardby coding preflight` proves it on every setup.
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: wardby
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = "/etc/containerd/certs.d"
nodes:
  - role: control-plane
```

- [ ] **Step 2: Base manifests**

`namespace.yaml`: Namespace `wardby-coding` with label `app.kubernetes.io/part-of: wardby`.

`service-accounts.yaml`: ServiceAccount `wardby-coding-worker` with `automountServiceAccountToken: false` (no RBAC bound — workers get no API access); ServiceAccount `wardby-coding-proxy` with `automountServiceAccountToken: false`.

`default-deny.yaml`: NetworkPolicy `default-deny-all`, `podSelector: {}`, `policyTypes: [Ingress, Egress]`, no rules.

`proxy.yaml`:

- Deployment `wardby-coding-proxy`: 1 replica; pod labels `app.kubernetes.io/name: wardby-coding-proxy`; `serviceAccountName: wardby-coding-proxy`; image `wardby-runtime` (placeholder name substituted at apply time); `command: ["node", "dist/coding-proxy/main.js"]`; `envFrom: [{ secretRef: { name: wardby-coding-proxy-env } }]` plus `NODE_ENV=production`; container port 8787; pod `securityContext` `runAsNonRoot: true`, `runAsUser: 1000` (the runtime image's `node` user), `seccompProfile: RuntimeDefault`; container `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]`; an `emptyDir` (`medium: Memory`, 64Mi) at `/tmp`; resources 250m / 256Mi; readiness probe TCP 8787.
- Service `wardby-coding-proxy`: ClusterIP, port 8787 → 8787, selector `app.kubernetes.io/name: wardby-coding-proxy`.
- NetworkPolicy `wardby-coding-proxy`: `podSelector` the proxy label; `ingress` only from pods labeled `wardby.io/component: coding-run` on TCP 8787; `egress`: (1) DNS — UDP and TCP 53 to `namespaceSelector: { kubernetes.io/metadata.name: kube-system }` with `podSelector: { k8s-app: kube-dns }`; (2) HTTPS — TCP 443 to `ipBlock: { cidr: 0.0.0.0/0, except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10] }`. (The database rule is per-environment; see the overlay.)

`launcher-role.yaml`: Role `wardby-coding-launcher` in `wardby-coding` with exactly: `pods` (create, get, list, watch, delete), `pods/exec` (create, get), `pods/log` (get), `secrets` (create, get, delete), `configmaps` (create, get, update), `networkpolicies` in `networking.k8s.io` (create, get, delete), `services` (get). No RoleBinding in base (the `kind` control plane uses your admin kubeconfig; Plan 3 binds this Role to the Cloud Run service account).

`quota.yaml`: ResourceQuota `wardby-coding` with `pods: "20"`, `requests.cpu: "8"`, `requests.memory: 16Gi`, `limits.cpu: "8"`, `limits.memory: 16Gi`, `requests.ephemeral-storage: 64Gi`.

`base/kustomization.yaml` lists all six files with `namespace: wardby-coding`.

- [ ] **Step 3: The `kind` overlay**

`overlays/kind/kustomization.yaml`: `resources: [../../base, proxy-database-egress.yaml]`.

`overlays/kind/proxy-database-egress.yaml`: an additional NetworkPolicy `wardby-coding-proxy-database` selecting the proxy pods, `policyTypes: [Egress]`, allowing TCP 55432 to `ipBlock: { cidr: 0.0.0.0/0 }` (the local Postgres published by `deploy/local` on the Docker host; the proxy reaches it at `host.docker.internal:55432`).

- [ ] **Step 4: `up.sh`**

`set -euo pipefail`, run from the repo root, requiring `kind`, `kubectl`, `docker`. In order:

1. Start the registry if absent: `docker run -d --restart=always -p 127.0.0.1:5001:5000 --network bridge --name kind-registry registry:2`.
2. Create the cluster if absent: `kind create cluster --config deploy/kind-coding/kind-config.yaml`.
3. For each node (`kind get nodes --name wardby`): write `/etc/containerd/certs.d/localhost:5001/hosts.toml` containing `[host."http://kind-registry:5000"]` via `docker exec`; connect the registry to the `kind` network (`docker network connect kind kind-registry`, ignoring "already exists").
4. Build and push images: `docker build -f src/coding-worker/Dockerfile -t localhost:5001/wardby-coding-worker:dev .` and `docker build -f deploy/Dockerfile --target runtime -t localhost:5001/wardby-runtime:dev .`, `docker push` both, then resolve digests with `docker inspect --format '{{index .RepoDigests 0}}'`.
5. Verify the worker image has `tar` and `head`: `docker run --rm --entrypoint sh <worker digest> -c 'command -v tar && command -v head && command -v test'` (fail with a clear message otherwise — Task 5's seeding and collection depend on them).
6. Apply the namespace, then create/replace the proxy Secret from `.env.local` without printing values: read `DATABASE_URL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`; rewrite `@localhost:` / `@127.0.0.1:` in `DATABASE_URL` to `@host.docker.internal:`; `kubectl -n wardby-coding create secret generic wardby-coding-proxy-env --from-literal=... --dry-run=client -o yaml | kubectl apply -f -` (values passed via environment variables, never echoed).
7. Render and apply: `kubectl kustomize deploy/kind-coding/manifests/overlays/kind | sed "s|image: wardby-runtime|image: ${RUNTIME_DIGEST}|" | kubectl --context kind-wardby apply -f -`; `kubectl -n wardby-coding rollout status deploy/wardby-coding-proxy --timeout=120s`.
8. Print the three `.env.local` lines with the resolved worker digest, and the next command: `npm run cli -- coding preflight`.

`down.sh`: `kind delete cluster --name wardby`; `docker rm -f kind-registry` (both tolerate absence).

`README.md`: purpose (local proof of the Kubernetes launcher, not production), prerequisites (Docker Desktop, `kind` ≥ 0.33, `kubectl`, local Postgres from `npm run db:up` or already running, `.env.local` with model keys), `up.sh` → edit `.env.local` → `wardby coding preflight` → run; `down.sh`; what it proves and doesn't (no gVisor, no Autopilot rules — Plan 3); the preflight canary as the network-enforcement proof and what to do if it fails (the fallback is installing Calico; document the `kind` `disableDefaultCNI: true` + Calico manifest steps, citing Calico's official docs).

- [ ] **Step 5: Bring it up and prove the network layer**

Run: `bash deploy/kind-coding/up.sh`
Expected: cluster, registry, proxy rollout complete; three `.env.local` lines printed. Add them to `.env.local` (keep the previous Docker values commented, not deleted).
Run: `npm run cli -- coding preflight`
Expected: `coding preflight passed (namespace, proxy-service, worker-image, canary) for localhost:5001/wardby-coding-worker@sha256:…`. **If the canary fails on `internet`, `metadata`, or `dns`, kindnet is not enforcing policy on this machine: stop and report — the fallback (Calico) is a cluster rebuild, recorded as a ruling.**

- [ ] **Step 6: Commit**

```bash
chmod +x deploy/kind-coding/up.sh deploy/kind-coding/down.sh
git add deploy/kind-coding
git commit -m "feat(deploy): local kind harness for the Kubernetes coding launcher

kind cluster with a local registry, the in-cluster coding proxy, default-
deny networking, the launcher's namespace Role, and a ResourceQuota.
up.sh builds and pushes the worker and runtime images, creates the proxy's
Secret from .env.local without printing or committing values, and prints
the .env.local lines for JOB_LAUNCHER=kubernetes."
```

---

### Task 8: Integration tests against a real cluster

**Files:**

- Create: `src/providers/jobs/kubernetes.integration.test.ts`
- Modify: `package.json` (script `test:kubernetes`)

**Interfaces:** Consumes the Task 7 cluster. The suite is skipped unless `WARDBY_KUBERNETES_TEST=1`, `KUBERNETES_CONTEXT`, and a registry-digest `CODING_WORKER_IMAGE` are set; `npm test` stays cluster-free.

What it proves on real Kubernetes (things the fake cannot): the API server's defaulting doesn't break attestation; seeding and the gate work; the pod really is isolated; failures, stop, and remove behave; the record survives as a tombstone.

- [ ] **Step 1: Write the suite**

Create `src/providers/jobs/kubernetes.integration.test.ts`:

```typescript
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { ClientNodeKubernetesApi } from "./kubernetes-client.js";
import { KubernetesJobLauncher } from "./kubernetes.js";
import { kubernetesRunNames } from "./kubernetes-isolation.js";
import type { JobSpec } from "./types.js";

const enabled =
  process.env.WARDBY_KUBERNETES_TEST === "1" &&
  !!process.env.KUBERNETES_CONTEXT &&
  /@sha256:[a-f0-9]{64}$/.test(process.env.CODING_WORKER_IMAGE ?? "");

describe.skipIf(!enabled)("KubernetesJobLauncher against a real cluster", () => {
  const namespace = process.env.KUBERNETES_NAMESPACE ?? "wardby-coding";
  const api = new ClientNodeKubernetesApi({ context: process.env.KUBERNETES_CONTEXT });
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
  });

  async function setup() {
    const runId = `k8s-it-${randomBytes(6).toString("hex")}`;
    const root = await mkdtemp(join(tmpdir(), "wardby-k8s-it-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspaces");
    await mkdir(join(workspaceRoot, runId, "workspace"), { recursive: true });
    await writeFile(join(workspaceRoot, runId, "workspace", "README.md"), "integration\n");
    const inputArtifact = join(root, "input.json");
    // Deliberately not a valid coding input: the worker must fail fast with a safe code.
    await writeFile(inputArtifact, "{}");
    const spec: JobSpec = {
      kind: "coding-agent",
      runId,
      provider: "codex",
      image: process.env.CODING_WORKER_IMAGE!,
      inputArtifact,
      timeoutSec: 300,
      limits: { cpus: 0.5, memoryMb: 512, pids: 128, diskMb: 256 },
      labels: {},
    };
    const launcher = new KubernetesJobLauncher({
      api,
      config: { namespace, proxyService: "wardby-coding-proxy" },
      workspaceRoot,
      resolveCapability: async () => `rrp_${randomBytes(24).toString("hex")}`,
    });
    return { spec, launcher, names: kubernetesRunNames(runId) };
  }

  async function keeperRun(podName: string, command: string[]): Promise<{ code: number; out: string }> {
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (c: Buffer) => chunks.push(c));
    const code = await api.exec(namespace, podName, "keeper", command, { stdout, timeoutMs: 30_000 });
    return { code, out: Buffer.concat(chunks).toString("utf8") };
  }

  async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 120_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (done(value) || Date.now() > end) return value;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  it("launches an attested, isolated pod; a failing worker yields a safe diagnostic; remove cleans up", async () => {
    const { spec, launcher, names } = await setup();
    const handle = await launcher.launch(spec);

    // Isolation, observed from inside the pod (the keeper shares the worker's network namespace).
    const probe = await keeperRun(names.pod, [
      "node",
      "-e",
      [
        'const net=require("node:net"),dns=require("node:dns").promises,fs=require("node:fs");',
        "const tcp=(h,p)=>new Promise(d=>{const s=net.connect({host:h,port:p,timeout:3000});",
        's.once("connect",()=>{s.destroy();d(true)});s.once("timeout",()=>{s.destroy();d(false)});s.once("error",()=>d(false))});',
        '(async()=>{let rootWritable=true;try{fs.writeFileSync("/probe","x")}catch{rootWritable=false}',
        "console.log(JSON.stringify({uid:process.getuid(),rootWritable,",
        'token:fs.existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token"),',
        'dns:await dns.lookup("kubernetes.default.svc.cluster.local").then(()=>true,()=>false),',
        'internet:await tcp("1.1.1.1",443),metadata:await tcp("169.254.169.254",80),',
        'proxy:await tcp("wardby-proxy",8787)}))})()',
      ].join(""),
    ]);
    expect(probe.code).toBe(0);
    expect(JSON.parse(probe.out.trim())).toEqual({
      uid: 10001,
      rootWritable: false,
      token: false,
      dns: false,
      internet: false,
      metadata: false,
      proxy: true,
    });

    const status = await until(
      () => launcher.status(handle),
      (s) => s.state === "failed" || s.state === "succeeded",
    );
    expect(status.state).toBe("failed");
    const result = await launcher.collect(handle);
    expect(result.reason).toBe("failed");
    expect(result.diagnostic ?? "").toMatch(/^(?:worker_[a-z_]+|coding_[a-z_]+|wardby_[a-z_]+)?$/);

    await launcher.remove(handle);
    expect(await api.readPod(namespace, names.pod)).toBeUndefined();
    expect(await api.readNetworkPolicy(namespace, names.policy)).toBeUndefined();
    await expect(launcher.status(handle)).rejects.toThrow("job_removed");
    expect(await launcher.launch(spec)).toEqual(handle);
  }, 240_000);

  it("stops a running job and reports it as stopped", async () => {
    const { spec, launcher, names } = await setup();
    const handle = await launcher.launch({ ...spec, timeoutSec: 600 });
    await launcher.stop(handle, "integration stop");
    expect(await launcher.status(handle)).toEqual({ state: "stopped" });
    expect(await launcher.collect(handle)).toEqual({ exitCode: 143, reason: "stopped" });
    await launcher.remove(handle);
    await until(
      () => api.readPod(namespace, names.pod),
      (pod) => pod === undefined,
      60_000,
    );
  }, 180_000);

  it("rejects a conflicting relaunch of the same run", async () => {
    const { spec, launcher } = await setup();
    const handle = await launcher.launch(spec);
    await expect(launcher.launch({ ...spec, timeoutSec: spec.timeoutSec + 1 })).rejects.toThrow("job_spec_conflict");
    await launcher.stop(handle);
    await launcher.remove(handle);
  }, 180_000);
});
```

- [ ] **Step 2: Add the script and run it**

Add to `package.json` scripts: `"test:kubernetes": "WARDBY_KUBERNETES_TEST=1 vitest run src/providers/jobs/kubernetes.integration.test.ts"`.

Run (with the Task 7 cluster up and `.env.local` holding the Kubernetes lines): `npm run test:kubernetes`
Expected: 3 tests PASS. If attestation fails on real defaults, fix the projection in `kubernetes-isolation.ts` (normalize the specific defaulted field) with a unit test for it — never loosen a security field. Also run `npm test` and confirm the suite is skipped there.

- [ ] **Step 3: Commit**

```bash
git add src/providers/jobs/kubernetes.integration.test.ts package.json
git commit -m "test(jobs): prove the Kubernetes launcher and pod isolation against a real cluster"
```

---

### Task 9: Per-agent workspace size (`workspaceDiskMb`)

**Files:**

- Modify: `prisma/schema.prisma` (`CodingAgentProfile`, `CodingRun`)
- Create: `prisma/migrations/20260922020000_coding_workspace_disk/migration.sql`
- Modify: `src/coding/profile.ts`, `src/mcp/tools/agents.ts` (`profileJsonSchema`, `storedProfile`, and every place the profile's fields are persisted)
- Modify: `src/core/dispatch.ts` (`codingRun.create`)
- Modify: `src/providers/executor/container.ts` (`ContainerRunSnapshot`, `PrismaContainerExecutionStore.load`, `jobSpec`)
- Tests: `src/coding/profile.test.ts`, `src/providers/executor/container.test.ts`, plus the dispatch and agents tests that cover profile fields

**Interfaces:** Produces `CodingProfile.workspaceDiskMb: number | null` (integer 64–32768, default `null`), copied onto `CodingRun.workspaceDiskMb` at dispatch, and `ContainerRunSnapshot.workspaceDiskMb: number | null`. `jobSpec` uses it for `limits.diskMb` when set; otherwise the deployment default (`CODING_DISK_MB`). The Kubernetes launcher sizes the pod's disk-backed workspace from `limits.diskMb` (Task 3); the Docker launcher's RAM-backed volume follows it too.

The simplest correct way to find every touch point: **mirror the existing `toolchainVersion` field** (a nullable, optional profile field) everywhere it appears — `git grep -n toolchainVersion -- src prisma` — adding `workspaceDiskMb` beside it, then additionally copy it at dispatch and read it in `jobSpec`.

- [ ] **Step 1: Write failing tests**

In `src/coding/profile.test.ts`, add:

```typescript
it("accepts an optional per-agent workspace size between 64 MiB and 32 GiB", () => {
  const base = { repository: "openai/example" };
  expect(CodingProfileSchema.parse(base).workspaceDiskMb).toBeNull();
  expect(CodingProfileSchema.parse({ ...base, workspaceDiskMb: 8192 }).workspaceDiskMb).toBe(8192);
  for (const bad of [32, 64.5, 40_000]) {
    expect(() => CodingProfileSchema.parse({ ...base, workspaceDiskMb: bad })).toThrow();
  }
  expect(CodingProfilePatchSchema.parse({ workspaceDiskMb: null })).toEqual({ workspaceDiskMb: null });
});
```

In `src/providers/executor/container.test.ts`, add (the `snapshot()` helper gains `workspaceDiskMb: null` as a default):

```typescript
it("sizes the job's workspace from the run's per-agent workspaceDiskMb", async () => {
  const created = await harness({ workspaceDiskMb: 8192 });
  await created.executor.start("run-1");
  expect(created.jobs.specs[0]?.limits.diskMb).toBe(8192);
});

it("falls back to the deployment's default disk size", async () => {
  const created = await harness();
  await created.executor.start("run-1");
  expect(created.jobs.specs[0]?.limits.diskMb).toBe(512);
});
```

(If `FakeJobs` doesn't record launched specs yet, add a `specs: JobSpec[]` array it pushes to in `launch`.)

Run: `npx vitest run src/coding/profile.test.ts src/providers/executor/container.test.ts` — expected FAIL.

- [ ] **Step 2: Schema and migration**

Add `workspaceDiskMb Int?` to `model CodingAgentProfile` (after `workerImageRef`) and to `model CodingRun` (after `queuedAt`), each with a `///` doc comment ("Per-agent workspace size in MiB; null = CODING_DISK_MB"). Create `prisma/migrations/20260922020000_coding_workspace_disk/migration.sql`:

```sql
-- Additive: per-agent coding workspace size. See
-- docs/superpowers/specs/2026-09-22-phase-12-kubernetes-job-launcher-design.md §4.

-- AlterTable
ALTER TABLE "CodingAgentProfile" ADD COLUMN     "workspaceDiskMb" INTEGER;

-- AlterTable
ALTER TABLE "CodingRun" ADD COLUMN     "workspaceDiskMb" INTEGER;
```

Apply: `npm run prisma:migrate && npm run prisma:generate` (do not run `npm run db:up`). Drift check with the `.env.local` credentials:

```bash
docker exec local-postgres-1 psql -U reevo -d reevo -c "DROP DATABASE IF EXISTS reevo_shadow;" -c "CREATE DATABASE reevo_shadow;"
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "postgresql://reevo:reevo@localhost:55432/reevo_shadow" --script
docker exec local-postgres-1 psql -U reevo -d reevo -c "DROP DATABASE IF EXISTS reevo_shadow;"
npx prisma validate
```

Expected: `-- This is an empty migration.` and a valid schema. (If `psql -c "CREATE DATABASE"` is blocked in your environment, `createdb`/`dropdb` inside the container are equivalent.)

- [ ] **Step 3: Implement**

- `src/coding/profile.ts`: `workspaceDiskMb: z.number().int().min(64).max(32_768).nullable()` in `codingProfileFields`; `.default(null)` in `CodingProfileSchema`; `.optional()` in `CodingProfilePatchSchema`.
- `src/mcp/tools/agents.ts`: `workspaceDiskMb: { type: ["integer", "null"], minimum: 64, maximum: 32768 }` in `profileJsonSchema`; include it wherever `toolchainVersion` is read or written (`storedProfile`, create, update).
- `src/core/dispatch.ts`: `workspaceDiskMb: agent.codingProfile.workspaceDiskMb ?? null` in `tx.codingRun.create`.
- `src/providers/executor/container.ts`: `workspaceDiskMb: number | null` on `ContainerRunSnapshot`; `workspaceDiskMb: row.codingRun.workspaceDiskMb` in `load`; in `jobSpec`, `limits: { ...this.options.limits, ...(run.workspaceDiskMb ? { diskMb: run.workspaceDiskMb } : {}) }`.

- [ ] **Step 4: Verify and commit**

Run: the Step 1 tests, then `npm run typecheck && npm run lint && npm test && npm run format:check`.

```bash
git add prisma/schema.prisma prisma/migrations/20260922020000_coding_workspace_disk src/coding/profile.ts src/coding/profile.test.ts src/mcp/tools/agents.ts src/core/dispatch.ts src/providers/executor/container.ts src/providers/executor/container.test.ts
git commit -m "feat(coding): per-agent workspace size (workspaceDiskMb)

Coding profiles can set a workspace size in MiB (64 MiB - 32 GiB); it is
copied onto the run at dispatch and used for the job's disk limit, falling
back to CODING_DISK_MB. On Kubernetes this sizes the pod's disk-backed
workspace, so large repositories don't need the whole deployment's default
raised. Additive migration; drift check clean."
```

(Also append `git add` for any other test files you changed in Step 3.)

---

### Task 10: Documentation, spec corrections, and the live Codex smoke on `kind`

**Files:**

- Modify: `docs/coding-worker-isolation.md` (new section "Kubernetes launcher")
- Modify: `docs/superpowers/specs/2026-09-22-phase-12-kubernetes-job-launcher-design.md` (corrections)
- Create: `docs/phase-12-kubernetes-evidence.md`

**Interfaces:** Consumes everything above and the Task 7 cluster. The live smoke spends a small amount of model credit and opens a real draft PR, so it is run by the controller **with the user**: the user names the throwaway repository the GitHub App is installed on.

- [ ] **Step 1: Document the launcher**

Add a "Kubernetes launcher (`JOB_LAUNCHER=kubernetes`)" section to `docs/coding-worker-isolation.md` covering: the pod layout (keeper + gated worker, disk-backed workspace sized by `workspaceDiskMb`/`CODING_DISK_MB`); `hostAliases` for the proxy and no DNS; the per-run NetworkPolicy under a namespace default-deny; where state lives (record ConfigMap, capability Secret, tombstones) and why; attestation before the gate opens; the preflight canary (on first launch and via `wardby coding preflight`); diagnostics from a bounded, pattern-validated log tail (with the planned move to `diagnostic.json`); the strict extractor; the settings (`KUBERNETES_*`, registry-digest images); the known gaps (no per-pod PID limit without gVisor; Claude Code arrives in Plan 2b; tombstone records accumulate — one small ConfigMap per run — until a cleanup job exists); and a pointer to `deploy/kind-coding/README.md`.

- [ ] **Step 2: Record the spec corrections**

In the spec, add a subsection "Corrections from implementation planning (2026-09-22)" listing the five Global Constraint corrections of this plan, and edit the affected sentences in §3 (keeper as a regular container; the worker's start gate), §4 (extractor symlink rule), §5 (`hostAliases`; DNS denied), and §7 (the `pods/log` permission and why; the Role now lists `pods/log` and `configmaps`) so the spec no longer contradicts the code.

- [ ] **Step 3: Live smoke (controller + user)**

1. Cluster up (Task 7) and `.env.local` holds `JOB_LAUNCHER=kubernetes`, `KUBERNETES_CONTEXT=kind-wardby`, the worker digest, and the GitHub App values; `npm run cli -- coding preflight` passes.
2. Register a local stdio MCP server for this branch: `claude-personal mcp add wardby-local -- sh -c 'cd /Users/chfields/Personal/wardby && exec npx tsx src/cli.ts mcp'`, restart the session, and confirm `wardby-local` connects.
3. Create a Codex coding agent through `wardby-local` (`create_agent` with `kind: "coding"`, `codingProfile: { provider: "codex", repository: <user's test repo>, defaultTask: "Create smoke.md containing exactly one line: kubernetes launcher smoke" }`, a Codex-supported model from `list_models`, budget `0.25`), then `trigger_agent`.
4. While it runs, `kubectl --context kind-wardby -n wardby-coding get pods,networkpolicies,configmaps,secrets` shows the run's objects; afterwards only the record ConfigMap remains.
5. `get_run` until terminal: expect `succeeded` with `codingResult.outcome` `pull_request_opened` and a draft PR URL whose diff is exactly `smoke.md`.
6. Record in `docs/phase-12-kubernetes-evidence.md`: date, branch/commit, `kind` version, preflight output, run ID, terminal result, PR URL, cost, and the object lifecycle observed. Then close the fixture PR and delete its `wardby/run-*` branch (ask the user before deleting anything on GitHub).

- [ ] **Step 4: Commit**

```bash
npx prettier --write docs/coding-worker-isolation.md docs/superpowers/specs/2026-09-22-phase-12-kubernetes-job-launcher-design.md docs/phase-12-kubernetes-evidence.md
git add docs/coding-worker-isolation.md docs/superpowers/specs/2026-09-22-phase-12-kubernetes-job-launcher-design.md docs/phase-12-kubernetes-evidence.md
git commit -m "docs: Kubernetes launcher docs, spec corrections, and kind smoke evidence"
```

---

## Self-review notes

- **Spec coverage (Plan 2a scope):** launcher implementing `WorkspaceJobLauncher` → Task 5; pod layout, keeper, disk-backed workspace → Tasks 3, 5; transfer through the Kubernetes API + strict extractor → Tasks 4, 5; isolation builders + attestation + fail-closed → Tasks 3, 5; network policies + DNS denial + metadata block → Tasks 3, 7; preflight canary on first launch and via CLI → Task 6; per-agent size → Task 9; `kind` harness with enforcing network layer + local registry → Task 7; real-cluster tests → Task 8; live Codex smoke → Task 10; docs/spec → Task 10. **Deliberately out of scope:** Claude Code (Plan 2b: `validateKubernetesSpec` refuses it with `kubernetes_provider_unsupported`); GKE, gVisor, Workload Identity, Cloud Logging exclusion, debug window (Plan 3); `diagnostic.json` (later, per the user's decision).
- **Where this plan specifies behavior instead of transcribing code:** Task 2's client-node adapter (its exact calls depend on the installed 2.x typings, which the typecheck enforces) and Task 5's launcher (≈450 lines; every behavior, error code, and edge case is listed, and the complete test file — including the shared contract suite — is given). Both tasks should go to the most capable implementer model.
- **Spec corrections found while planning** are listed in Global Constraints and written back to the spec in Task 10.
- **Known limitation:** tombstone record ConfigMaps accumulate (one small object per run); a cleanup job is future work, noted in the docs.
- **Type/name consistency:** `KubernetesJobConfig` (Task 1) → Tasks 5–6; `KubernetesApi`, `FakeKubernetesApi`, error classes (Task 2) → Tasks 5, 6, 8; `kubernetesRunNames`, `runLabels`, `buildRunPod`, `buildRunNetworkPolicy`, `buildCapabilitySecret`, `assertRunPodMatches`, `assertRunNetworkPolicyMatches`, `validateKubernetesSpec`, `isRegistryDigest`, `KEEPER_CONTAINER`, `WORKER_CONTAINER`, `STORAGE_ROOT`, `KEEPER_SEEDED_MARKER`, `PROXY_POD_LABEL` (Task 3) → Tasks 5, 6, 8; `safeExtract` (Task 4) → Task 5; `replaceDirectoryFromStaging`, `SAFE_WORKER_DIAGNOSTIC` (Task 5) → Task 5; `kubernetesPreflight` (Task 6) → Tasks 6, 7.
