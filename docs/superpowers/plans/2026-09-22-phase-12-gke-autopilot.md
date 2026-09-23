# Phase 12 Plan 3a: Running the Kubernetes Coding Launcher on GKE Autopilot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One real coding run on a GKE Autopilot cluster, sandboxed with gVisor, with deny-by-default attestation intact.

**Architecture:** Two independent changes plus a live proof. (1) The enforcement witness moves from `kube-system/kube-dns` — which does not exist on Autopilot — to a second listener on the trusted coding proxy, the **deny port**, that no run's NetworkPolicy ever permits. One probe measures both ports of the same destination pod and counts only `(8787 connected, 8788 blocked)` as proof, which nothing but a programmed, port-scoped policy can produce. (2) A named **platform profile** (`generic` | `gke-autopilot`) carries the resource rules the builder conforms to before submitting (so Autopilot has nothing left to rewrite) and the exact metadata Autopilot still stamps on, normalized away on **both** sides of the comparator. Everything outside that named list still fails the run. A server-side dry-run capture tool records the real mutation set into a committed fixture so CI exercises the profile without a cluster.

**Tech Stack:** TypeScript / Node 24 (Node 22+ target), `@kubernetes/client-node` 2.x, Vitest, kustomize/kubectl, `kind` (local proof), GKE Autopilot + gVisor (live proof).

**Spec:** `docs/superpowers/specs/2026-09-22-phase-12-gke-autopilot-design.md`. Builds on `docs/superpowers/specs/2026-09-22-phase-12-kubernetes-job-launcher-design.md` and the evidence in `docs/phase-12-kubernetes-evidence.md`.

**Revision:** revised 2026-09-22 after review (`.superpowers/gke-plan-review.md`). The material changes: the gate probes both ports in one exec (previously only the deny port, which released a worker on a drop-style dataplane when the proxy was down); the task that deleted `readNamespace` and the namespace-reader ClusterRole is cut; the preflight and ready timeouts become environment-settable because a cold Autopilot cluster exceeds the hard-coded ones; the live task deploys a throwaway in-cluster database instead of assuming one.

## Global Constraints

- **Never commit to `main`.** Task 0 creates the working branch `phase-12-gke-autopilot`. Never push without being asked.
- **Security-critical code.** `kubernetes-isolation.ts` (the canonical builders and the deny-by-default comparator), `kubernetes-preflight.ts` (the canary), and `KubernetesJobLauncher.waitForPolicyEnforcement` (the per-launch gate) are the isolation boundary. Three properties must not regress in any task:
  1. **Deny-by-default comparison.** `assertRunPodMatches` still deep-compares the entire pod spec, labels, and annotations. A profile may only _delete named keys on both sides_; it may never add an allowlist of fields to skip, and it may never short-circuit the comparison.
  2. **The gate still blocks.** No worker is released until `ENFORCEMENT_BLOCKED_STREAK` (3) consecutive probes come back proven, 500 ms apart, bounded by `enforcementTimeoutMs`, failing with `kubernetes_policy_not_enforced`.
  3. **The witness is never vacuous.** "Blocked" only counts as evidence when the very same probe just observed that something is listening on the other end.
- **`generic` tolerates nothing new.** Every profile-driven allowance is empty for `generic`; a test asserts this explicitly (Tasks 4, 5, 7).
- **Clean-room (CLEANROOM.md):** write everything from this plan and the spec; copy no external code.
- **Deployment rules (CLAUDE.md "Deployment (deploy/) — STRICT"):** no project id, region, cluster name, domain, or real credential may land in a tracked file. Nothing produced only to validate a deployment (tfvars, state, captured resource ids) gets committed. The evidence doc records outcomes, never identities.
- **No new billable cloud resources except in Task 9**, which is explicitly approval-gated.
- **Verification for every task:** `npm run typecheck`, `npm run lint`, `npm test`, `npm run format:check`. Tasks touching the `kind` harness additionally run `npm run test:kubernetes` (Task 8 onwards).
- **Commit messages end with:**
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4`.

## Decisions this plan makes (the spec left these open)

| Question                    | Decision                                                                                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deny port number            | **8788** — `CODING_PROXY_DENY_PORT`, exported from `src/providers/jobs/docker-isolation.ts` beside `CODING_PROXY_PORT`.                                                                                                            |
| Who may reach the deny port | The proxy's own NetworkPolicy **must allow** ingress on 8788 from `wardby.io/component: coding-run` pods. See "Why" below — without this the witness is vacuous.                                                                   |
| What the gate measures      | Both ports in **one** exec: proven only when 8787 connected and 8788 was blocked. Exit 0 proven, 3 deny port reachable, 4 proxy unreachable.                                                                                       |
| Profile data shape          | `src/providers/jobs/kubernetes-platform.ts`: pure data (`KubernetesPlatformProfile`) + two pure functions (`conformResources`, `normalizePlatformMetadata`) + one config assertion (`assertPlatformConfig`).                       |
| Fixture location and shape  | `src/providers/jobs/fixtures/gke-autopilot-dry-run.json`, storing a **mutation list** (JSON-Pointer ops) rather than two whole pods, so the test rebuilds `submitted` from the live builder.                                       |
| Capture tool location       | `src/tools/capture-autopilot-dry-run.ts`, run with `npm run capture:autopilot` (tsx). Inside `src/` because `tsconfig.json` sets `rootDir: src`.                                                                                   |
| Ephemeral-storage split     | `storage-init` 64 MiB, `keeper` `diskMb` MiB (it owns the storage volume), `worker` 1024 MiB. Pod total = `diskMb + 1024`.                                                                                                         |
| Timeouts on a cold cluster  | `KUBERNETES_PREFLIGHT_TIMEOUT_MS` and `KUBERNETES_READY_TIMEOUT_MS`, bounded integers defaulting to today's 90 000 / 120 000.                                                                                                      |
| GKE manifests location      | A new kustomize overlay `deploy/kind-coding/manifests/overlays/gke-autopilot/`, reusing the existing cluster-agnostic `base`. No new `deploy/<cloud>/` Terraform module: the Autopilot run is a proof, not a reference deployment. |
| The live run's database     | A throwaway single-replica Postgres **inside the cluster**, destroyed with it. No Cloud SQL: it is another billable resource with its own teardown, and a smoke run needs no durability.                                           |

**Why the proxy policy must allow 8788 from run pods.** NetworkPolicy ingress is enforced at the _destination_, and a denial drops the packet rather than rejecting it. The proxy's policy is programmed long before any run pod exists. If it did not list 8788, a connect from a run pod whose **own egress policy had not yet been programmed** would still be dropped — at the proxy's ingress — and the probe would read "blocked". The gate would then open while the run pod had no egress policy at all and full internet access. Allowing 8788 at the proxy makes the run pod's own egress policy the _only_ thing that can block it, which is exactly what the gate must measure. The listener serves nothing, so reachability costs nothing.

**Why the gate measures both ports.** "Blocked" is only evidence if something is listening. A control-plane read of the Service's endpoints proves that a few seconds earlier — a time-of-check/time-of-use window — and an `ECONNREFUSED` discrimination only works on dataplanes that _reject_. GKE Dataplane V2 (Cilium), which is what Autopilot runs, **drops**. So a dead proxy plus an unprogrammed policy would look exactly like a healthy enforced one. Measuring 8787 in the same exec turns "something is listening" from a control-plane inference into a fact the pod itself just observed, at the instant of the blocked observation. The canary already works this way, and the spec's decision table describes exactly these three outcomes.

## File structure

| File                                                                                      | Responsibility                                                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/providers/jobs/docker-isolation.ts` (modify)                                         | `CODING_PROXY_DENY_PORT = 8788` beside the existing proxy constants.                                    |
| `src/providers/coding-proxy/deny-port.ts` (create)                                        | The deny-port listener: accept, destroy, serve nothing.                                                 |
| `src/providers/coding-proxy/runtime.ts` (modify)                                          | Starts both listeners; one handle closes both.                                                          |
| `src/providers/jobs/kubernetes-witness.ts` (create)                                       | `readProxyWitness`: the Service exposes both ports and has a ready endpoint serving both.               |
| `src/providers/jobs/kubernetes-platform.ts` (create)                                      | Platform profiles: resource rules, metadata allowances, gVisor requirement, conformance, config checks. |
| `src/providers/jobs/kubernetes-dry-run-fixture.ts` (create)                               | The fixture's types, the JSON-Pointer applier, and the differ the capture tool uses.                    |
| `src/providers/jobs/fixtures/gke-autopilot-dry-run.json` (create)                         | The recorded Autopilot mutation set.                                                                    |
| `src/tools/capture-autopilot-dry-run.ts` (create)                                         | Submits the built pod with `dryRun=All` and writes the fixture.                                         |
| `src/providers/jobs/kubernetes-isolation.ts` (modify)                                     | Probe script → both proxy ports; builder resource conformance; profile-aware normalization.             |
| `src/providers/jobs/kubernetes-preflight.ts` (modify)                                     | Canary → deny port; `platform` check; `proxy-service` vacuity guard; `cluster-dns` deleted.             |
| `src/providers/jobs/kubernetes.ts` (modify)                                               | Gate → both ports on the freshly read proxy IP; `KubernetesClusterInfo.proxyIp`; platform plumbed in.   |
| `src/providers/jobs/kubernetes-api.ts` / `-client.ts` / `fake-kubernetes-api.ts` (modify) | `dryRunCreatePod` added.                                                                                |
| `src/config/providers.ts` (modify)                                                        | `KUBERNETES_PLATFORM`, `KUBERNETES_PREFLIGHT_TIMEOUT_MS`, `KUBERNETES_READY_TIMEOUT_MS`.                |
| `src/providers/executor/composition.ts`, `src/cli.ts` (modify)                            | Startup refusal, the new timeouts, the new preflight option, the renamed cluster-info field.            |
| `deploy/kind-coding/manifests/base/*` (modify/delete)                                     | Deny port exposed; the kube-system dns-reader Role deleted; a namespace-local endpoints grant added.    |
| `deploy/kind-coding/manifests/overlays/gke-autopilot/*` (create)                          | Autopilot overlay: Cloud DNS egress, throwaway database, database egress.                               |
| `docs/coding-worker-isolation.md`, `docs/phase-12-kubernetes-evidence.md` (modify)        | Documentation and live evidence.                                                                        |

---

### Task 0: Branch and baseline

**Files:**

- No source changes.

**Interfaces:**

- Consumes: nothing.
- Produces: branch `phase-12-gke-autopilot`, a green baseline every later task compares against.

- [ ] **Step 1: Create the working branch**

```bash
cd /Users/chfields/Personal/wardby
git checkout main
git pull --ff-only
git checkout -b phase-12-gke-autopilot
```

- [ ] **Step 2: Prove the baseline is green before changing anything**

```bash
npm run typecheck && npm run lint && npm test && npm run format:check
```

Expected: all four pass (the reviewed baseline is 138 files, 1465 passed, 9 skipped). If `npm test` fails here, stop and report — no task in this plan is diagnosable on a red baseline.

---

### Task 1: The proxy's deny-port listener

**Files:**

- Modify: `src/providers/jobs/docker-isolation.ts` (add a constant beside `CODING_PROXY_PORT`, line 9)
- Create: `src/providers/coding-proxy/deny-port.ts`
- Test: `src/providers/coding-proxy/deny-port.test.ts`
- Modify: `src/providers/coding-proxy/runtime.ts`
- Test: `src/providers/coding-proxy/runtime.test.ts`
- Modify: `deploy/kind-coding/manifests/base/proxy.yaml`

**Interfaces:**

- Consumes: `CODING_PROXY_ALIAS`, `CODING_PROXY_PORT` from `./docker-isolation.js`; `startCodingProxyServer`, `CodingProxyServerHandle` from `./server.js`.
- Produces:
  - `CODING_PROXY_DENY_PORT: 8788` (from `src/providers/jobs/docker-isolation.ts`)
  - `startDenyPortListener(host: string, port: number): Promise<DenyPortListenerHandle>`
  - `interface DenyPortListenerHandle { port: number; close(): Promise<void> }`
  - `CodingProxyRuntimeOptions.startDenyPort?: typeof startDenyPortListener`

**Security note:** this adds a listener to the _trusted_ component. It must accept the connection, close it, and serve nothing — no HTTP parsing, no routing, no credentials, no logging of peer data. `pauseOnConnect: true` means the socket is never read. Note that `startConfiguredCodingProxy` is the only proxy entry point, so **every** deployment (Docker included) gains this listener; Task 3 documents that.

- [ ] **Step 1: Write the failing listener test**

Create `src/providers/coding-proxy/deny-port.test.ts`:

```ts
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { startDenyPortListener } from "./deny-port.js";

/** Connects once and reports whether the connect succeeded and how many bytes the server sent. */
async function probe(port: number): Promise<{ connected: boolean; bytes: number }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 3000 });
    let connected = false;
    let bytes = 0;
    socket.on("connect", () => {
      connected = true;
    });
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    socket.on("timeout", () => socket.destroy());
    // The server destroys the socket, so the client sees ECONNRESET *after* connecting; only a
    // pre-connect error (e.g. ECONNREFUSED) is a real failure.
    socket.on("error", (error) => {
      if (!connected) reject(error);
    });
    socket.on("close", () => resolve({ connected, bytes }));
  });
}

describe("deny-port listener", () => {
  it("accepts a connection, sends nothing, and closes it immediately", async () => {
    const listener = await startDenyPortListener("127.0.0.1", 0);
    try {
      expect(await probe(listener.port)).toEqual({ connected: true, bytes: 0 });
    } finally {
      await listener.close();
    }
  });

  it("stops accepting once closed", async () => {
    const listener = await startDenyPortListener("127.0.0.1", 0);
    const { port } = listener;
    await listener.close();
    await expect(probe(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("rejects a port already in use rather than starting silently", async () => {
    const first = await startDenyPortListener("127.0.0.1", 0);
    try {
      await expect(startDenyPortListener("127.0.0.1", first.port)).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await first.close();
    }
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx vitest run src/providers/coding-proxy/deny-port.test.ts`
Expected: FAIL — `Failed to resolve import "./deny-port.js"`.

- [ ] **Step 3: Write the listener**

Create `src/providers/coding-proxy/deny-port.ts`:

```ts
/**
 * The coding proxy's second listener: the *deny port*.
 *
 * It exists only to be unreachable. No run's NetworkPolicy ever permits a
 * coding-run pod to reach it, so a run pod that can connect to the proxy on
 * CODING_PROXY_PORT but not on CODING_PROXY_DENY_PORT has proven its policy is
 * programmed and port-scoped — something no accident can produce, and the one
 * witness a cluster without kube-dns (GKE Autopilot, where Cloud DNS is the
 * only provider) still has.
 *
 * It must therefore serve nothing at all: the socket is never read
 * (`pauseOnConnect`), nothing is ever written to it, and it is destroyed the
 * moment it is accepted. There is no protocol here to attack and no credential
 * to leak — only the fact that the TCP handshake completed.
 */
import { createServer } from "node:net";

export interface DenyPortListenerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startDenyPortListener(host: string, port: number): Promise<DenyPortListenerHandle> {
  const server = createServer({ pauseOnConnect: true }, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    // Left registered after listen(): a later 'error' event on a net.Server with no listener
    // crashes the process, and rejecting an already-settled promise is a no-op.
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
```

- [ ] **Step 4: Run the listener test**

Run: `npx vitest run src/providers/coding-proxy/deny-port.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the port constant**

In `src/providers/jobs/docker-isolation.ts`, immediately after `export const CODING_PROXY_PORT = 8787;` (line 9):

```ts
/**
 * The proxy's deny port. Nothing is served here (see coding-proxy/deny-port.ts);
 * it is the enforcement witness — the one destination a run's NetworkPolicy must
 * refuse while permitting CODING_PROXY_PORT on the same pod.
 */
export const CODING_PROXY_DENY_PORT = 8788;
```

- [ ] **Step 6: Write the failing runtime-wiring test**

Append to `src/providers/coding-proxy/runtime.test.ts` (inside the existing `describe`):

```ts
it("starts the deny-port listener alongside the proxy and closes both", async () => {
  const closed: string[] = [];
  const handle: CodingProxyServerHandle = {
    port: CODING_PROXY_PORT,
    close: async () => void closed.push("proxy"),
  };
  const startServer = vi.fn(async () => handle);
  const startDenyPort = vi.fn(async () => ({
    port: CODING_PROXY_DENY_PORT,
    close: async () => void closed.push("deny"),
  }));

  const started = await startConfiguredCodingProxy({
    db: {} as PrismaClient,
    env: { OPENAI_API_KEY: "test-secret" },
    startServer,
    startDenyPort,
  });

  expect(startDenyPort).toHaveBeenCalledWith("0.0.0.0", CODING_PROXY_DENY_PORT);
  expect(started.port).toBe(CODING_PROXY_PORT);
  await started.close();
  expect(closed).toEqual(["deny", "proxy"]);
});

it("closes the proxy server when the deny port cannot bind", async () => {
  const closed: string[] = [];
  const handle: CodingProxyServerHandle = {
    port: CODING_PROXY_PORT,
    close: async () => void closed.push("proxy"),
  };
  await expect(
    startConfiguredCodingProxy({
      db: {} as PrismaClient,
      env: { OPENAI_API_KEY: "test-secret" },
      startServer: async () => handle,
      startDenyPort: async () => {
        throw new Error("EADDRINUSE");
      },
    }),
  ).rejects.toThrow("EADDRINUSE");
  expect(closed).toEqual(["proxy"]);
});
```

Update that file's import line 3 to `import { CODING_PROXY_ALIAS, CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "../jobs/docker-isolation.js";`.

- [ ] **Step 7: Run it to watch it fail**

Run: `npx vitest run src/providers/coding-proxy/runtime.test.ts`
Expected: FAIL — `startDenyPort` is not a known option, so the listener is never called (`expect(startDenyPort).toHaveBeenCalledWith` fails).

- [ ] **Step 8: Wire it into the runtime**

In `src/providers/coding-proxy/runtime.ts`, change the import on line 2 to include the new constant, add the deny-port import, extend the options, and start both:

```ts
import { CODING_PROXY_ALIAS, CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "../jobs/docker-isolation.js";
import { startDenyPortListener } from "./deny-port.js";
```

```ts
export interface CodingProxyRuntimeOptions {
  db: PrismaClient;
  env?: NodeJS.ProcessEnv;
  startServer?: typeof startCodingProxyServer;
  startDenyPort?: typeof startDenyPortListener;
  audit?: ProxyAuditSink;
  onRequest?: (event: {
    protocol: "openai-responses" | "anthropic-messages" | "other";
    status: number;
    durationMs: number;
  }) => void;
}
```

```ts
/** Starts the trusted proxy with the fixed worker-only Docker endpoint, plus the deny port the enforcement witness probes. */
export async function startConfiguredCodingProxy(options: CodingProxyRuntimeOptions): Promise<CodingProxyServerHandle> {
  const env = options.env ?? process.env;
  const proxy = new CodingProxy({
    ledger: new PrismaProxyLedger(options.db),
    credentials: new EnvironmentCredentialResolver(env),
    audit: options.audit,
  });
  const startServer = options.startServer ?? startCodingProxyServer;
  const server = await startServer(proxy, {
    host: "0.0.0.0",
    port: CODING_PROXY_PORT,
    expectedHost: `${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}`,
    onRequest: options.onRequest,
  });
  let deny;
  try {
    deny = await (options.startDenyPort ?? startDenyPortListener)("0.0.0.0", CODING_PROXY_DENY_PORT);
  } catch (error) {
    // A proxy without its witness must not stay up: the launcher's gate would never be able to
    // prove a policy is enforced, and every launch would fail at the gate instead of at startup.
    await server.close();
    throw error;
  }
  return {
    port: server.port,
    close: async () => {
      await deny.close();
      await server.close();
    },
  };
}
```

- [ ] **Step 9: Run the runtime tests**

Run: `npx vitest run src/providers/coding-proxy/runtime.test.ts`
Expected: PASS (3 tests — the pre-existing endpoint test plus the two new ones).

- [ ] **Step 10: Expose the port in the manifests**

In `deploy/kind-coding/manifests/base/proxy.yaml`, in the Deployment's container, replace the `ports:` block:

```yaml
ports:
  - name: proxy
    containerPort: 8787
  - name: deny
    containerPort: 8788
```

Replace the Service's `ports:` block (a multi-port Service requires every port to be named):

```yaml
ports:
  - name: proxy
    port: 8787
    targetPort: 8787
  - name: deny
    port: 8788
    targetPort: 8788
```

Replace the proxy NetworkPolicy's `ingress:` block:

```yaml
ingress:
  - from:
      - podSelector:
          matchLabels:
            wardby.io/component: coding-run
    ports:
      - protocol: TCP
        port: 8787
      # 8788 is the deny port (coding-proxy/deny-port.ts). It is allowed *here*,
      # at the destination, on purpose. NetworkPolicy ingress is enforced on the
      # receiving pod and a denial drops the packet, and this policy is programmed
      # long before any run pod exists — so if 8788 were omitted, a connect from a
      # run pod whose own egress policy had not been programmed yet would still be
      # dropped, the enforcement probe would read "blocked", and the gate would
      # release a worker that in fact had full network access. Allowing it here
      # makes the run pod's own egress policy the only thing that can block it,
      # which is precisely what the gate measures. Nothing is served on this port.
      - protocol: TCP
        port: 8788
```

Leave `readinessProbe` on 8787: both listeners belong to one process, and `startConfiguredCodingProxy` aborts startup if the deny port cannot bind, so a Ready pod always has both.

- [ ] **Step 11: Render the manifests offline to check they are still valid**

Run: `kubectl kustomize deploy/kind-coding/manifests/overlays/kind | grep -c 8788`
Expected: `3` (container port, Service port, NetworkPolicy ingress port). This renders locally; it contacts no cluster.

- [ ] **Step 12: Full verification and commit**

```bash
npm run typecheck && npm run lint && npm test && npm run format:check
git add src/providers/coding-proxy/deny-port.ts src/providers/coding-proxy/deny-port.test.ts \
  src/providers/coding-proxy/runtime.ts src/providers/coding-proxy/runtime.test.ts \
  src/providers/jobs/docker-isolation.ts deploy/kind-coding/manifests/base/proxy.yaml
git commit -m "$(cat <<'EOF'
feat(coding-proxy): serve a deny port as the NetworkPolicy enforcement witness

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 2: The proxy witness read (vacuity guard)

**Files:**

- Create: `src/providers/jobs/kubernetes-witness.ts`
- Test: `src/providers/jobs/kubernetes-witness.test.ts`

**Interfaces:**

- Consumes: `CODING_PROXY_DENY_PORT`, `CODING_PROXY_PORT` (Task 1); `KubernetesApi.readService`, `KubernetesApi.readEndpoints` (`src/providers/jobs/kubernetes-api.ts`).
- Produces:
  - `const PROXY_WITNESS_UNUSABLE = "kubernetes_proxy_witness_unusable"`
  - `class ProxyWitnessError extends Error` (message: `` `${PROXY_WITNESS_UNUSABLE}: ${detail}` ``)
  - `interface ProxyWitness { clusterIp: string }`
  - `readProxyWitness(api: KubernetesApi, namespace: string, service: string): Promise<ProxyWitness>`

**Security note:** this is a control-plane cross-check that the deny port is configured at all. It is **not** the thing that keeps a probe from being vacuous — the two-port probe in Task 3 does that, at the instant of measurement. This read exists to fail a misconfigured deployment early and with a message that names what is missing.

- [ ] **Step 1: Write the failing test**

Create `src/providers/jobs/kubernetes-witness.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeKubernetesApi } from "./fake-kubernetes-api.js";
import { readProxyWitness } from "./kubernetes-witness.js";

const NAMESPACE = "wardby-coding";
const SERVICE = "wardby-coding-proxy";

function api(
  options: { ports?: number[]; endpointPorts?: number[]; addresses?: string[]; clusterIP?: string } = {},
): FakeKubernetesApi {
  const fake = new FakeKubernetesApi();
  const {
    ports = [8787, 8788],
    endpointPorts = [8787, 8788],
    addresses = ["10.244.0.5"],
    clusterIP = "10.96.0.50",
  } = options;
  fake.put("service", NAMESPACE, {
    metadata: { name: SERVICE },
    spec: { clusterIP, ports: ports.map((port) => ({ port, protocol: "TCP" })) },
  });
  fake.put("endpoints", NAMESPACE, {
    metadata: { name: SERVICE },
    subsets: [
      {
        addresses: addresses.map((ip) => ({ ip })),
        ports: endpointPorts.map((port) => ({ port, protocol: "TCP" })),
      },
    ],
  });
  return fake;
}

describe("readProxyWitness", () => {
  it("returns the ClusterIP when both ports are exposed and a ready endpoint serves both", async () => {
    expect(await readProxyWitness(api(), NAMESPACE, SERVICE)).toEqual({ clusterIp: "10.96.0.50" });
  });

  it("refuses a Service that does not expose the deny port", async () => {
    await expect(readProxyWitness(api({ ports: [8787] }), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy does not expose port 8788",
    );
  });

  it("refuses a Service with no ready endpoint address", async () => {
    await expect(readProxyWitness(api({ addresses: [] }), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy has no ready endpoint address",
    );
  });

  it("refuses when the ready endpoint does not serve the deny port", async () => {
    await expect(readProxyWitness(api({ endpointPorts: [8787] }), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: no ready endpoint of wardby-coding/wardby-coding-proxy serves port 8788",
    );
  });

  it("refuses a headless or missing Service", async () => {
    await expect(readProxyWitness(api({ clusterIP: "None" }), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy has no usable ClusterIP",
    );
    await expect(readProxyWitness(new FakeKubernetesApi(), NAMESPACE, SERVICE)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy has no usable ClusterIP",
    );
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx vitest run src/providers/jobs/kubernetes-witness.test.ts`
Expected: FAIL — `Failed to resolve import "./kubernetes-witness.js"`.

- [ ] **Step 3: Write the witness read**

Create `src/providers/jobs/kubernetes-witness.ts`:

```ts
/**
 * The proxy Service as the NetworkPolicy enforcement witness.
 *
 * The preflight canary and the per-launch gate both prove a run's policy is
 * enforced by requiring a connect to the proxy's deny port to be *refused*
 * while a connect to the proxy port succeeds. This read is the configuration
 * cross-check for that: the Service must expose both ports, and at least one
 * ready endpoint must serve both, or the deployment is misconfigured and says
 * so by name rather than failing later at a gate.
 *
 * Both reads are in wardby's own namespace, which the launcher Role permits.
 * (EndpointSlice is the durable successor to the core/v1 Endpoints read here;
 * migrating is a follow-up and needs its own resourceNames grant.)
 */
import { isIP } from "node:net";
import { CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "./docker-isolation.js";
import type { KubernetesApi } from "./kubernetes-api.js";

export const PROXY_WITNESS_UNUSABLE = "kubernetes_proxy_witness_unusable";

export class ProxyWitnessError extends Error {
  constructor(detail: string) {
    super(`${PROXY_WITNESS_UNUSABLE}: ${detail}`);
    this.name = "ProxyWitnessError";
  }
}

export interface ProxyWitness {
  /** The proxy Service's ClusterIP: the address both probed ports live on. */
  clusterIp: string;
}

const REQUIRED_PORTS = [CODING_PROXY_PORT, CODING_PROXY_DENY_PORT] as const;

export async function readProxyWitness(api: KubernetesApi, namespace: string, service: string): Promise<ProxyWitness> {
  const where = `Service ${namespace}/${service}`;
  const found = await api.readService(namespace, service);
  const clusterIp = found?.spec?.clusterIP;
  if (!clusterIp || clusterIp === "None" || isIP(clusterIp) === 0) {
    throw new ProxyWitnessError(`${where} has no usable ClusterIP`);
  }
  const exposed = new Set((found?.spec?.ports ?? []).map((port) => port.port));
  for (const required of REQUIRED_PORTS) {
    if (!exposed.has(required)) throw new ProxyWitnessError(`${where} does not expose port ${required}`);
  }
  const endpoints = await api.readEndpoints(namespace, service);
  const readyPorts = new Set<number>();
  for (const subset of endpoints?.subsets ?? []) {
    const ready = (subset.addresses ?? []).some((address) => typeof address.ip === "string" && isIP(address.ip) !== 0);
    if (!ready) continue;
    for (const port of subset.ports ?? []) if (typeof port.port === "number") readyPorts.add(port.port);
  }
  if (readyPorts.size === 0) throw new ProxyWitnessError(`${where} has no ready endpoint address`);
  for (const required of REQUIRED_PORTS) {
    if (!readyPorts.has(required)) {
      throw new ProxyWitnessError(`no ready endpoint of ${namespace}/${service} serves port ${required}`);
    }
  }
  return { clusterIp };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/providers/jobs/kubernetes-witness.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm run lint && npm test && npm run format:check
git add src/providers/jobs/kubernetes-witness.ts src/providers/jobs/kubernetes-witness.test.ts
git commit -m "$(cat <<'EOF'
feat(kubernetes): read the proxy Service as the enforcement witness

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 3: Switch the witness from kube-dns to the proxy's two ports

**Files:**

- Modify: `src/providers/jobs/kubernetes-isolation.ts` (delete `CLUSTER_DNS_*`, lines 38–40; rewrite `enforcementProbeScript`, lines 483–500)
- Test: `src/providers/jobs/kubernetes-isolation.test.ts`
- Modify: `src/providers/jobs/kubernetes-preflight.ts` (`CANARY_SCRIPT`, `CanaryResult`, `EXPECTED`, `canaryPasses`, `runCanary`, `runChecks`, `KubernetesPreflightResult`)
- Test: `src/providers/jobs/kubernetes-preflight.test.ts`
- Modify: `src/providers/jobs/kubernetes.ts` (`KubernetesClusterInfo`, `runPreflight`, `waitForPolicyEnforcement`, `launch`, `provision`)
- Test: `src/providers/jobs/kubernetes.test.ts`
- Modify: `src/providers/executor/composition.ts` (lines 74–76)
- Modify: `deploy/kind-coding/manifests/base/launcher-role.yaml`, `deploy/kind-coding/manifests/base/kustomization.yaml`
- Delete: `deploy/kind-coding/manifests/base/launcher-dns-reader-role.yaml`
- Modify: `docs/coding-worker-isolation.md`

**Interfaces:**

- Consumes: `readProxyWitness` (Task 2); `CODING_PROXY_DENY_PORT`, `CODING_PROXY_PORT` (Task 1).
- Produces:
  - `enforcementProbeScript(proxyIp: string): string` — signature changed (was `(clusterDnsIp: string)`)
  - Exported probe exit codes: `ENFORCEMENT_PROBE_PROVEN = 0`, `ENFORCEMENT_PROBE_DENY_REACHABLE = 3`, `ENFORCEMENT_PROBE_PROXY_UNREACHABLE = 4` (replacing the module-private `ENFORCEMENT_PROBE_CONNECTED`)
  - `interface CanaryResult { dns: boolean; proxyDeny: boolean; internet: boolean; metadata: boolean; proxy: boolean }` (was `clusterDns`)
  - `interface KubernetesPreflightResult { checks: string[]; proxyIp: string }` (was `clusterDnsIp`)
  - `interface KubernetesClusterInfo { proxyIp: string }` (was `clusterDnsIp`)
  - `private waitForPolicyEnforcement(names: RunNames, proxyIp: string): Promise<void>` (was `(names, cluster: KubernetesClusterInfo)`)
  - Removed exports: `CLUSTER_DNS_NAMESPACE`, `CLUSTER_DNS_SERVICE`; removed error code `kubernetes_cluster_dns_unavailable`
  - New launch-time error code: `kubernetes_policy_witness_unavailable`
  - Preflight check list: `["namespace", "proxy-service", "worker-image", "canary"]` (`platform` is added in Task 6)

**Security note:** this is the gate itself. The 3-consecutive-proven contract, the 3 s per-connect timeout, the 500 ms poll, and the `enforcementTimeoutMs` bound are unchanged. What changes is what is probed — and the probe gets strictly stronger: it now requires the proxy port to be _reachable_ in the same exec that found the deny port blocked, so "the proxy is gone and no policy exists" can no longer look like "enforced".

- [ ] **Step 1: Write the failing probe-script test**

In `src/providers/jobs/kubernetes-isolation.test.ts`, replace the existing `enforcementProbeScript` tests (search for `enforcementProbeScript`) with:

```ts
describe("enforcementProbeScript", () => {
  /** Drives the real script in a VM with a fake net, one outcome per port. */
  async function runProbe(script: string, outcome: Record<number, "connect" | "timeout" | "error">): Promise<number> {
    return new Promise((resolve) => {
      runInNewContext(script, {
        require: () => ({
          connect: ({ port }: { port: number }) => {
            const handlers: Record<string, () => void> = {};
            setTimeout(() => handlers[outcome[port]]?.(), 0);
            return {
              once: (event: string, handler: () => void) => void (handlers[event] = handler),
              destroy: () => {},
            };
          },
        }),
        process: { exit: (code: number) => resolve(code) },
        setTimeout,
      });
    });
  }

  it("measures both proxy ports with a SYN-safe 3 s connect timeout", () => {
    const script = enforcementProbeScript("10.96.0.50");
    expect(script).toContain('host: "10.96.0.50"');
    expect(script).toContain("timeout: 3000");
    expect(script).toContain("await tcp(8787)");
    expect(script).toContain("await tcp(8788)");
    expect(script).not.toContain("port: 53");
  });

  it("rejects an address that is not an IP", () => {
    expect(() => enforcementProbeScript("wardby-proxy")).toThrow(KUBERNETES_ISOLATION_ERROR);
    expect(() => enforcementProbeScript('10.0.0.1"; require("child_process")')).toThrow(KUBERNETES_ISOLATION_ERROR);
  });

  it("exits 0 only when the proxy port connected and the deny port was blocked", async () => {
    const script = enforcementProbeScript("10.96.0.50");
    expect(await runProbe(script, { 8787: "connect", 8788: "timeout" })).toBe(0);
    expect(await runProbe(script, { 8787: "connect", 8788: "connect" })).toBe(3);
    // Nothing listening / no policy programmed at all: not evidence of anything.
    expect(await runProbe(script, { 8787: "timeout", 8788: "timeout" })).toBe(4);
    expect(await runProbe(script, { 8787: "error", 8788: "timeout" })).toBe(4);
  });
});
```

`runInNewContext` is already imported at the top of this file (`node:vm`); add `enforcementProbeScript` to the import list from `./kubernetes-isolation.js` if it is not already there.

- [ ] **Step 2: Run it to watch it fail**

Run: `npx vitest run src/providers/jobs/kubernetes-isolation.test.ts -t enforcementProbeScript`
Expected: FAIL — the script still targets port 53 and has no two-port logic.

- [ ] **Step 3: Rewrite the probe script**

In `src/providers/jobs/kubernetes-isolation.ts`, delete lines 38–40 (the `CLUSTER_DNS_*` constants and their comment), replace the private `ENFORCEMENT_PROBE_CONNECTED` with three exported codes, and replace the trailing `enforcementProbeScript`:

```ts
/** The probe proved enforcement: the proxy port connected and the deny port was blocked. */
export const ENFORCEMENT_PROBE_PROVEN = 0;
/** The deny port was reachable: no policy is blocking it, or the policy is not port-scoped. */
export const ENFORCEMENT_PROBE_DENY_REACHABLE = 3;
/** The proxy port itself was unreachable: nothing could be witnessed (proxy down, or only the namespace default-deny is programmed). */
export const ENFORCEMENT_PROBE_PROXY_UNREACHABLE = 4;
```

```ts
/**
 * A `node -e` script (argv only, never a shell) that measures BOTH of the proxy's
 * ports in one pass, with a 3 s connect timeout each (above Linux's 1 s initial
 * SYN retransmission, so one dropped SYN on an allowed path still connects).
 *
 * Measuring both is what makes the result decisive. A NetworkPolicy denial drops
 * the packet rather than rejecting it — GKE Dataplane V2, which Autopilot runs,
 * always drops — so "the deny port did not answer" is equally consistent with
 * "the proxy is gone and no policy exists at all". Requiring the proxy port to
 * connect in the *same* probe turns "something is listening" from a control-plane
 * inference into a fact this pod just observed.
 *
 * Exit codes are ENFORCEMENT_PROBE_PROVEN / _DENY_REACHABLE / _PROXY_UNREACHABLE.
 * The IP is validated and embedded as a JSON string literal.
 */
export function enforcementProbeScript(proxyIp: string): string {
  if (isIP(proxyIp) === 0) throw isolationError();
  return [
    'const net = require("node:net");',
    "const tcp = (port) =>",
    "  new Promise((done) => {",
    "    const socket = net.connect({ host: " + JSON.stringify(proxyIp) + ", port, timeout: 3000 });",
    '    socket.once("connect", () => { socket.destroy(); done(true); });',
    '    socket.once("timeout", () => { socket.destroy(); done(false); });',
    '    socket.once("error", () => done(false));',
    "  });",
    "(async () => {",
    `  const allowed = await tcp(${CODING_PROXY_PORT});`,
    `  const denied = await tcp(${CODING_PROXY_DENY_PORT});`,
    `  if (!allowed) process.exit(${ENFORCEMENT_PROBE_PROXY_UNREACHABLE});`,
    `  process.exit(denied ? ${ENFORCEMENT_PROBE_DENY_REACHABLE} : ${ENFORCEMENT_PROBE_PROVEN});`,
    "})();",
  ].join("\n");
}
```

Add `CODING_PROXY_DENY_PORT` and `CODING_PROXY_PORT` to the existing import from `./docker-isolation.js` (lines 19–26).

- [ ] **Step 4: Run the probe tests**

Run: `npx vitest run src/providers/jobs/kubernetes-isolation.test.ts -t enforcementProbeScript`
Expected: PASS (3 tests).

- [ ] **Step 5: Update and extend the launcher's gate tests**

In `src/providers/jobs/kubernetes.test.ts`:

(a) Module-level probe matcher (line 17):

```ts
const isEnforcementProbe = (command: string[]) => command[0] === "node" && command[2].includes("await tcp(8788)");
```

(b) In `harness()` (around line 31), replace the `kube-system`/`kube-dns` Service `put` with the proxy's ports and endpoints:

```ts
api.put("service", "wardby-coding", {
  metadata: { name: "wardby-coding-proxy" },
  spec: {
    clusterIP: "10.96.0.50",
    ports: [
      { name: "proxy", port: 8787, protocol: "TCP" },
      { name: "deny", port: 8788, protocol: "TCP" },
    ],
  },
});
api.put("endpoints", "wardby-coding", {
  metadata: { name: "wardby-coding-proxy" },
  subsets: [
    {
      addresses: [{ ip: "10.244.0.5" }],
      ports: [
        { name: "proxy", port: 8787, protocol: "TCP" },
        { name: "deny", port: 8788, protocol: "TCP" },
      ],
    },
  ],
});
```

(c) Line ~427: `kubernetes_proxy_unavailable` becomes `kubernetes_proxy_witness_unusable`.

(d) `clockedLauncher`'s `extra` type (line ~744): `{ preflight?: () => Promise<{ proxyIp: string }> }`.

(e) Line ~839, the argv-shape test: `expect(probe.command[2]).toContain('host: "10.96.0.10", port: 53')` becomes

```ts
expect(probe.command[2]).toContain('host: "10.96.0.50"');
expect(probe.command[2]).toContain("await tcp(8788)");
```

(f) Replace the test at line ~878 ("uses the preflight's cluster DNS IP without reading kube-dns itself") — its subject is gone, and the launcher now probes the address it re-read for this launch rather than anything memoized:

```ts
it("probes the proxy ClusterIP it re-read for this launch, not a stale memoized one", async () => {
  const h = await harness();
  const { launcher } = clockedLauncher(h, { preflight: async () => ({ proxyIp: "10.96.0.99" }) });
  await launcher.launch(h.spec);
  const probe = h.api.execCalls.find((c) => isEnforcementProbe(c.command))!;
  expect(probe.command[2]).toContain('host: "10.96.0.50"');
  expect(probe.command[2]).not.toContain("10.96.0.99");
});
```

(g) Replace the test at line ~885 ("without a preflight, reads kube-dns once per launcher and fails closed when it is unusable") — `kubernetes_cluster_dns_unavailable` no longer exists:

```ts
it("without a preflight, fails closed when the proxy witness is unusable", async () => {
  const g = await harness("run-witness-b");
  g.api.put("service", "wardby-coding", {
    metadata: { name: "wardby-coding-proxy" },
    spec: { clusterIP: "None" },
  });
  await expect(g.launcher.launch(g.spec)).rejects.toThrow("kubernetes_isolation_unsupported");
  expect(g.api.objects.has(`pod/wardby-coding/${g.names.pod}`)).toBe(false);
});
```

(h) Add two new tests in the enforcement-gate describe. Both use `clockedLauncher(h)`, whose `sleep` advances its clock — `h.launcher`'s clock is frozen, so a gate that never reaches its streak would loop forever there:

```ts
it("reports an unavailable witness when the proxy port itself cannot be reached", async () => {
  const h = await harness();
  const { launcher } = clockedLauncher(h);
  const original = h.api.onExec;
  h.api.onExec = async (call) => (isEnforcementProbe(call.command) ? 4 : original(call));
  await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_policy_witness_unavailable");
  expect(h.api.execCalls.some((c) => isMarker(c.command))).toBe(false);
});

it("still reports not_enforced when the last probe found the deny port reachable", async () => {
  const h = await harness();
  const { launcher } = clockedLauncher(h);
  const original = h.api.onExec;
  let calls = 0;
  h.api.onExec = async (call) => {
    if (!isEnforcementProbe(call.command)) return original(call);
    calls += 1;
    // One unavailable probe early must not make the final verdict say "witness".
    return calls === 1 ? 4 : 3;
  };
  await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_policy_not_enforced");
});

it("refuses to launch when the proxy Service has no ready endpoint on the deny port", async () => {
  const h = await harness("run-no-deny-endpoint");
  h.api.put("endpoints", "wardby-coding", {
    metadata: { name: "wardby-coding-proxy" },
    subsets: [{ addresses: [{ ip: "10.244.0.5" }], ports: [{ port: 8787, protocol: "TCP" }] }],
  });
  await expect(h.launcher.launch(h.spec)).rejects.toThrow("kubernetes_proxy_witness_unusable");
});
```

- [ ] **Step 6: Run it to watch it fail**

Run: `npx vitest run src/providers/jobs/kubernetes.test.ts`
Expected: FAIL — the probes still target port 53, the witness read does not exist in `provision`, and exit 4 is treated as an ordinary "not blocked".

- [ ] **Step 7: Switch the launcher's gate and witness read**

In `src/providers/jobs/kubernetes.ts`:

Imports — drop `CLUSTER_DNS_NAMESPACE`/`CLUSTER_DNS_SERVICE`, add the probe code, and import the witness:

```ts
import {
  ENFORCEMENT_PROBE_PROXY_UNREACHABLE,
  KEEPER_CONTAINER,
  // ... unchanged entries ...
} from "./kubernetes-isolation.js";
import { readProxyWitness } from "./kubernetes-witness.js";
```

Cluster info:

```ts
export interface KubernetesClusterInfo {
  /** The proxy Service's ClusterIP: the enforcement witness's address (8787 reachable, 8788 not). */
  proxyIp: string;
}
```

`runPreflight` (lines 477–493):

```ts
  /** Memoized: the preflight (or, without one, a single proxy-witness read) runs once per launcher. */
  private runPreflight(): Promise<KubernetesClusterInfo> {
    this.preflightResult ??= (async () => {
      try {
        const provided = (await this.options.preflight?.())?.proxyIp;
        if (provided !== undefined) {
          if (isIP(provided) === 0) throw new Error("kubernetes_proxy_unavailable");
          return { proxyIp: provided };
        }
        const witness = await readProxyWitness(this.api, this.namespace, this.options.config.proxyService);
        return { proxyIp: witness.clusterIp };
      } catch (error) {
        throw errorWithCode(KUBERNETES_ISOLATION_ERROR, error);
      }
    })();
    return this.preflightResult;
  }
```

`waitForPolicyEnforcement` (lines 495–513) — takes the address the caller just read, so the freshness check and the probed address cannot diverge:

```ts
  /**
   * Waits until the run's NetworkPolicy is enforced on this pod: the keeper (same network namespace
   * as the worker) must, on ENFORCEMENT_BLOCKED_STREAK consecutive probes 500 ms apart, reach the
   * proxy on CODING_PROXY_PORT and fail to reach it on CODING_PROXY_DENY_PORT. Anything else resets
   * the streak; the wall-clock bound still applies.
   *
   * The verdict at the bound is taken from the *last* probe, not from whether any probe was ever
   * unavailable: an early blip while the pod's networking came up must not send an operator looking
   * at the proxy when the real problem is an unenforced policy.
   */
  private async waitForPolicyEnforcement(names: RunNames, proxyIp: string): Promise<void> {
    const command = ["node", "-e", enforcementProbeScript(proxyIp)];
    const started = this.now();
    let blocked = 0;
    let lastExitCode = -1;
    for (;;) {
      const exitCode = await this.api.exec(this.namespace, names.pod, KEEPER_CONTAINER, command, {
        timeoutMs: ENFORCEMENT_EXEC_TIMEOUT_MS,
      });
      lastExitCode = exitCode;
      blocked = exitCode === 0 ? blocked + 1 : 0;
      if (blocked >= ENFORCEMENT_BLOCKED_STREAK) return;
      if (this.now() - started >= this.enforcementTimeoutMs) {
        throw new Error(
          lastExitCode === ENFORCEMENT_PROBE_PROXY_UNREACHABLE
            ? "kubernetes_policy_witness_unavailable"
            : "kubernetes_policy_not_enforced",
        );
      }
      await this.sleep(ENFORCEMENT_POLL_MS);
    }
  }
```

Update the comment on `ENFORCEMENT_EXEC_TIMEOUT_MS` (line 74): the probe now makes two sequential connects, so it gives up after at most 6 s — still comfortably inside the 10 s exec bound.

`launch` (line 363) and `provision` — the preflight still gates every launch, but the gate's address comes from this launch's own read:

```ts
await this.runPreflight();
```

```ts
  private async provision(spec: JobSpec, names: RunNames, record: RunRecord): Promise<void> {
```

(and the call site becomes `await this.provision(spec, names, record);`)

In `provision`, replace the Service read (lines 537–539):

```ts
// Re-read (not just the ClusterIP): the gate below reads "deny port unreachable" as evidence,
// which is only meaningful against a Service that actually exposes it with a ready backend.
const witness = await readProxyWitness(this.api, this.namespace, proxyService);
const proxyIp = witness.clusterIp;
```

and the gate call (line 557):

```ts
await this.waitForPolicyEnforcement(names, proxyIp);
```

- [ ] **Step 8: Run the launcher tests**

Run: `npx vitest run src/providers/jobs/kubernetes.test.ts`
Expected: PASS — including the two rewritten tests from step 5(f) and 5(g) and the three added in 5(h). If anything still references `kubernetes_cluster_dns_unavailable` or `kube-system`, it was missed in step 5; fix it there rather than restoring the old behaviour.

- [ ] **Step 9: Write the failing canary test**

In `src/providers/jobs/kubernetes-preflight.test.ts`:

(a) Replace the `cluster()` helper's Service/Endpoints setup (lines 19–24):

```ts
api.put("service", "wardby-coding", {
  metadata: { name: "wardby-coding-proxy" },
  spec: {
    clusterIP: "10.96.0.50",
    ports: [
      { name: "proxy", port: 8787, protocol: "TCP" },
      { name: "deny", port: 8788, protocol: "TCP" },
    ],
  },
});
api.put("endpoints", "wardby-coding", {
  metadata: { name: "wardby-coding-proxy" },
  subsets: [
    {
      addresses: [{ ip: "10.244.0.5" }],
      ports: [
        { name: "proxy", port: 8787, protocol: "TCP" },
        { name: "deny", port: 8788, protocol: "TCP" },
      ],
    },
  ],
});
```

(b) Rename every `clusterDns` to `proxyDeny` in this file, and delete the three `cluster-dns` failure tests (lines ~255–300). Leave the tests at lines ~303 and ~407 alone — despite mentioning `readNamespace`, they are the whole-preflight-timeout bound and the "canary output never reaches the operator" redaction test, both of which still apply.

(c) Update the passing-checks assertion (line ~439) to `checks: ["namespace", "proxy-service", "worker-image", "canary"]` and `proxyIp: "10.96.0.50"`.

(d) Update the canary-script execution test (lines ~460–505): its fake `process.env` becomes `{ WARDBY_CANARY_PROXY_IP: "10.96.0.50" }` only, its `tcp` stub keys on port 8788 instead of 53, and the assertion `output.wardbyCanary.clusterDns` becomes `output.wardbyCanary.proxyDeny`.

(e) Add:

```ts
it("fails proxy-service when the Service does not expose the deny port", async () => {
  const api = cluster(ok);
  api.put("service", "wardby-coding", {
    metadata: { name: "wardby-coding-proxy" },
    spec: { clusterIP: "10.96.0.50", ports: [{ name: "proxy", port: 8787, protocol: "TCP" }] },
  });
  await expect(kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {} })).rejects.toThrow(
    "kubernetes_isolation_unsupported:proxy-service",
  );
});

it("names the reason the proxy witness is unusable", async () => {
  const api = cluster(ok);
  api.put("endpoints", "wardby-coding", { metadata: { name: "wardby-coding-proxy" }, subsets: [] });
  const error = await kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {} }).catch(
    (e: unknown) => e,
  );
  expect(describePreflightFailure(error)).toContain("has no ready endpoint address");
});

it("fails the canary when the deny port is reachable", async () => {
  const api = cluster({ ...ok, proxyDeny: true });
  await expect(kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {} })).rejects.toThrow(
    "kubernetes_isolation_unsupported:canary",
  );
});
```

- [ ] **Step 10: Run it to watch it fail**

Run: `npx vitest run src/providers/jobs/kubernetes-preflight.test.ts`
Expected: FAIL — `proxyDeny` is not a canary key and the `cluster-dns` check still runs.

- [ ] **Step 11: Switch the canary and the checks**

In `src/providers/jobs/kubernetes-preflight.ts`:

Imports — drop `CLUSTER_DNS_NAMESPACE`/`CLUSTER_DNS_SERVICE`, add the ports and the witness:

```ts
import { CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "./docker-isolation.js";
import { readProxyWitness } from "./kubernetes-witness.js";
```

Result shape and expectations:

```ts
export interface CanaryResult {
  dns: boolean;
  /** The proxy's deny port: reachable means the run policy is not being enforced. */
  proxyDeny: boolean;
  internet: boolean;
  metadata: boolean;
  proxy: boolean;
}
```

```ts
const EXPECTED: CanaryResult = { dns: false, proxyDeny: false, internet: false, metadata: false, proxy: true };
```

The script (replacing lines 52–96's doc comment and body):

```ts
/**
 * Runs in the worker image under the run policy; prints exactly one `{"wardbyCanary":{...}}` line.
 * `dns` checks in-pod resolution; `proxyDeny` checks the policy itself — a TCP connect to the *same*
 * proxy pod on a port no run policy permits, which a namespace-wide allow-all policy would reopen.
 * Probing one destination on two ports is what makes the result decisive: `proxy` true with
 * `proxyDeny` false can only mean a policy is enforced and port-scoped.
 * CNIs program a new pod's policy a few seconds after it starts, so the script first waits (up to
 * 20 s) for the deny-port connect to be blocked; if it never is, `proxyDeny` reports true.
 */
export const CANARY_SCRIPT = [
  'const net = require("node:net");',
  'const dns = require("node:dns").promises;',
  "const tcp = (host, port) =>",
  "  new Promise((done) => {",
  "    const socket = net.connect({ host, port, timeout: 3000 });",
  '    socket.once("connect", () => {',
  "      socket.destroy();",
  "      done(true);",
  "    });",
  '    socket.once("timeout", () => {',
  "      socket.destroy();",
  "      done(false);",
  "    });",
  '    socket.once("error", () => done(false));',
  "  });",
  "const settle = async () => {",
  "  const until = Date.now() + 20000;",
  "  while (Date.now() < until) {",
  `    if (!(await tcp(process.env.WARDBY_CANARY_PROXY_IP, ${CODING_PROXY_DENY_PORT}))) return;`,
  "    await new Promise((wake) => setTimeout(wake, 500));",
  "  }",
  "};",
  "(async () => {",
  "  await settle();",
  "  const wardbyCanary = {",
  '    dns: await dns.lookup("kubernetes.default.svc.cluster.local").then(',
  "      () => true,",
  "      () => false,",
  "    ),",
  `    proxyDeny: await tcp(process.env.WARDBY_CANARY_PROXY_IP, ${CODING_PROXY_DENY_PORT}),`,
  '    internet: await tcp("1.1.1.1", 443),',
  '    metadata: await tcp("169.254.169.254", 80),',
  `    proxy: await tcp(process.env.WARDBY_CANARY_PROXY_IP, ${CODING_PROXY_PORT}),`,
  "  };",
  "  console.log(JSON.stringify({ wardbyCanary }));",
  "})();",
].join("\n");
```

`canaryPasses` — replace the `result.clusterDns === EXPECTED.clusterDns` line with `result.proxyDeny === EXPECTED.proxyDeny`.

`runCanary` — drop the `clusterDnsIp` parameter and set a single env var:

```ts
worker.env = [{ name: "WARDBY_CANARY_PROXY_IP", value: proxyIp }];
```

`runChecks` — keep the `namespace` check exactly as it is, delete the whole `cluster-dns` block (lines 296–318), make `proxy-service` the witness read, and delete the now-unused `serviceClusterIp` helper:

```ts
const proxyIp = await runCheck("proxy-service", async () => {
  const witness = await readProxyWitness(api, config.namespace, config.proxyService);
  return witness.clusterIp;
});
passed.push("proxy-service");

if (!isRegistryDigest(workerImage)) throw failure("worker-image");
passed.push("worker-image");

await runCanary(options, state, proxyIp, timeoutMs, cleanupTimeoutMs);
passed.push("canary");
return proxyIp;
```

Result type and the two `clusterDnsIp` locals in `runKubernetesPreflight`:

```ts
export interface KubernetesPreflightResult {
  checks: string[];
  /** The validated proxy Service ClusterIP; the launcher probes both of its ports to wait for each run's policy. */
  proxyIp: string;
}
```

Also update the module doc comment (lines 1–9): the canary now proves that DNS, the internet, the metadata server and **the proxy's deny port** are unreachable while the proxy itself is reachable.

- [ ] **Step 12: Run the preflight tests**

Run: `npx vitest run src/providers/jobs/kubernetes-preflight.test.ts`
Expected: PASS.

- [ ] **Step 13: Update the composition call site**

In `src/providers/executor/composition.ts`, lines 74–76:

```ts
      preflight: async () => {
        const { proxyIp } = await runKubernetesPreflight({ api, config: kubernetes, workerImage });
        return { proxyIp };
      },
```

- [ ] **Step 14: Delete the kube-system Role and grant the namespace-local endpoints read**

```bash
git rm deploy/kind-coding/manifests/base/launcher-dns-reader-role.yaml
```

In `deploy/kind-coding/manifests/base/kustomization.yaml`, remove the `- launcher-dns-reader-role.yaml` line and replace the header comment:

```yaml
# No top-level `namespace:` override here on purpose: kustomize's namespace
# transformer forces metadata.namespace on every namespaced resource it lists,
# and each resource below already declares its own (wardby-coding).
# launcher-namespace-reader.yaml's ClusterRole is cluster-scoped and has none.
# Nothing in this tree reads kube-system any more — the enforcement witness is
# the coding proxy's own deny port, in this namespace (see base/proxy.yaml).
```

In `deploy/kind-coding/manifests/base/launcher-role.yaml`, extend the `services` rule:

```yaml
- apiGroups: [""]
  resources: ["services"]
  verbs: ["get"]
- apiGroups: [""]
  # The enforcement witness: readProxyWitness (src/providers/jobs/kubernetes-witness.ts) reads the
  # proxy Service's Endpoints to prove the deny port is exposed with a ready backend before a run
  # is gated on it. One object wide. EndpointSlice is the durable successor to Endpoints;
  # migrating is a follow-up and needs its own resourceNames grant.
  resources: ["endpoints"]
  resourceNames: ["wardby-coding-proxy"]
  verbs: ["get"]
```

- [ ] **Step 15: Update the isolation documentation**

In `docs/coding-worker-isolation.md`:

(a) Replace the `### Preflight` list item 3 (`cluster-dns`, the long GKE/Cloud DNS paragraph at lines 439–466) and renumber. The checks are `namespace`, `proxy-service`, `worker-image`, `canary` (Task 6 adds `platform` in front). Write the `proxy-service` entry as:

```markdown
2. `proxy-service` — the proxy Service exists, has a ClusterIP, **exposes both
   the proxy port (8787) and the deny port (8788)**, and has at least one ready
   endpoint serving both, failing closed with
   `kubernetes_isolation_unsupported:proxy-service` otherwise. The deny port is
   the enforcement witness: a second listener on the proxy
   (`src/providers/coding-proxy/deny-port.ts`) that serves nothing and that no
   run's NetworkPolicy ever permits. A run pod that reaches 8787 but not 8788
   has proven its policy is both programmed and port-scoped. It replaces the old
   `cluster-dns` witness, which does not exist on GKE Autopilot (Cloud DNS is the
   only provider there, so no kube-dns pods run) and which made the launcher read
   `kube-system`.
```

(b) Update the enforcement-gate section (lines ~420–431): the gate execs one probe that measures both ports and counts only `(8787 connected, 8788 blocked)` toward its three-consecutive streak; a probe that cannot reach 8787 at all proves nothing and, at the bound, reports `kubernetes_policy_witness_unavailable` instead of `kubernetes_policy_not_enforced`. Say plainly why both ports are measured: a policy denial drops rather than rejects, so a single-port probe cannot tell an enforced policy from a dead proxy.

(c) Add, in the proxy's own section:

```markdown
The deny port ships to **every** deployment, not just Kubernetes:
`startConfiguredCodingProxy` is the only proxy entry point, so a Docker
deployment's proxy also binds `0.0.0.0:8788` (and refuses to start if it
cannot). No host port is published for it, so there is no port conflict. In
Docker mode a run container can reach it, since a Docker network has no
port-level policy — that is harmless, because the listener accepts the
connection, sends nothing and closes it. It is not a leak; it is a fact about
reachability that the Kubernetes launcher turns into evidence.
```

- [ ] **Step 16: Full verification and commit**

```bash
npm run typecheck && npm run lint && npm test && npm run format:check
kubectl kustomize deploy/kind-coding/manifests/overlays/kind | grep -c "kube-system"
```

Expected: the kustomize render's `kube-system` count is `1` — only the proxy's own DNS egress rule, no Role.

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(kubernetes): witness policy enforcement with the proxy's two ports, not kube-dns

The gate now measures 8787 and 8788 in one probe and counts only
(proxy reachable, deny port blocked). A NetworkPolicy denial drops rather than
rejects, so a single-port probe could not tell an enforced policy from a dead
proxy on a drop-style dataplane -- which is what GKE Autopilot runs.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 4: Platform profiles and the launcher's environment knobs

**Files:**

- Create: `src/providers/jobs/kubernetes-platform.ts`
- Test: `src/providers/jobs/kubernetes-platform.test.ts`
- Modify: `src/config/providers.ts` (`KubernetesJobConfig`, `loadKubernetesJobConfig`, lines 167–185)
- Test: `src/config/providers.test.ts`
- Modify: `src/providers/executor/composition.ts`, `src/cli.ts`

**Interfaces:**

- Consumes: `optionalBoundedInteger` and `dnsLabel` (module-private helpers already in `src/config/providers.ts`).
- Produces (all from `src/providers/jobs/kubernetes-platform.ts`):
  - `type KubernetesPlatform = "generic" | "gke-autopilot"`
  - `const KUBERNETES_PLATFORMS: readonly KubernetesPlatform[]`
  - `const KUBERNETES_PLATFORM_ERROR = "kubernetes_platform_unconformable"`
  - `class KubernetesPlatformError extends Error`
  - `interface PlatformResourceRules`, `interface PlatformMetadataAllowance`, `interface KubernetesPlatformProfile`
  - `function platformProfile(name: KubernetesPlatform): KubernetesPlatformProfile`
  - `interface ContainerResourceRequest { cpuMillicores: number; memoryMib: number; ephemeralStorageMib?: number }`
  - `interface ContainerResources { requests: Record<string, string>; limits: Record<string, string> }`
  - `function conformResources(profile: KubernetesPlatformProfile, request: ContainerResourceRequest): ContainerResources`
  - `function podEphemeralStorageMib(diskMb: number): number`
  - `function normalizePlatformMetadata(profile, view: { labels; annotations; spec: V1PodSpec }): void`
  - `function assertPlatformConfig(profile, config: { runtimeClassName?: string; maxDiskMb: number }): void`
  - `const GVISOR_RUNTIME_CLASS = "gvisor"`, `const STORAGE_INIT_EPHEMERAL_MIB = 64`, `const WORKER_EPHEMERAL_MIB = 1024`
  - From `src/config/providers.ts`: `KubernetesJobConfig.platform: KubernetesPlatform`, `KubernetesJobConfig.preflightTimeoutMs?: number`, `KubernetesJobConfig.readyTimeoutMs?: number`

**Security note:** `normalizePlatformMetadata` is the only place a difference between the submitted and the read-back pod may be _forgiven_. It deletes named keys from both sides symmetrically; it never compares, never skips a subtree, and for `generic` has nothing to delete.

- [ ] **Step 1: Write the failing profile test**

Create `src/providers/jobs/kubernetes-platform.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { V1PodSpec } from "@kubernetes/client-node";
import {
  KUBERNETES_PLATFORM_ERROR,
  assertPlatformConfig,
  conformResources,
  normalizePlatformMetadata,
  platformProfile,
  podEphemeralStorageMib,
} from "./kubernetes-platform.js";

const generic = platformProfile("generic");
const autopilot = platformProfile("gke-autopilot");

describe("conformResources", () => {
  it("leaves a generic request exactly as asked", () => {
    expect(conformResources(generic, { cpuMillicores: 500, memoryMib: 512 })).toEqual({
      requests: { cpu: "500m", memory: "512Mi" },
      limits: { cpu: "500m", memory: "512Mi" },
    });
    expect(conformResources(generic, { cpuMillicores: 100, memoryMib: 128 })).toEqual({
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "100m", memory: "128Mi" },
    });
  });

  it("raises CPU to Autopilot's floor and rounds to its increment", () => {
    const at = (cpuMillicores: number) =>
      conformResources(autopilot, { cpuMillicores, memoryMib: 2048, ephemeralStorageMib: 64 }).requests.cpu;
    expect(at(100)).toBe("250m");
    expect(at(600)).toBe("750m");
    expect(at(1000)).toBe("1000m");
  });

  it("raises memory to the 1:1 floor of the memory:CPU band", () => {
    // The keeper's 250m/128Mi is a 0.5:1 ratio, which Autopilot would silently raise.
    expect(conformResources(autopilot, { cpuMillicores: 250, memoryMib: 128, ephemeralStorageMib: 64 })).toEqual({
      requests: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "64Mi" },
      limits: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "64Mi" },
    });
  });

  it("raises CPU rather than lowering memory when the 6.5:1 ceiling is exceeded", () => {
    const conformed = conformResources(autopilot, { cpuMillicores: 250, memoryMib: 8192, ephemeralStorageMib: 1024 });
    expect(conformed.requests.memory).toBe("8192Mi");
    // 8192 / 6656 MiB-per-vCPU = 1.2308 vCPU, rounded up to the 250m increment.
    expect(conformed.requests.cpu).toBe("1250m");
  });

  it("emits limits equal to requests on every platform", () => {
    const conformed = conformResources(autopilot, { cpuMillicores: 500, memoryMib: 512, ephemeralStorageMib: 1024 });
    expect(conformed.limits).toEqual(conformed.requests);
  });

  it("refuses an Autopilot container with no ephemeral-storage request", () => {
    expect(() => conformResources(autopilot, { cpuMillicores: 500, memoryMib: 512 })).toThrow(
      KUBERNETES_PLATFORM_ERROR,
    );
  });
});

describe("podEphemeralStorageMib", () => {
  it("is the keeper's storage plus the worker's reservation", () => {
    expect(podEphemeralStorageMib(2048)).toBe(3072);
  });
});

describe("assertPlatformConfig", () => {
  it("accepts anything under generic", () => {
    expect(() => assertPlatformConfig(generic, { maxDiskMb: 32_768 })).not.toThrow();
    expect(() => assertPlatformConfig(generic, { runtimeClassName: undefined, maxDiskMb: 64 })).not.toThrow();
  });

  it("requires gvisor under gke-autopilot", () => {
    expect(() => assertPlatformConfig(autopilot, { maxDiskMb: 2048 })).toThrow(
      "requires KUBERNETES_RUNTIME_CLASS=gvisor (found unset)",
    );
    expect(() => assertPlatformConfig(autopilot, { runtimeClassName: "runsc", maxDiskMb: 2048 })).toThrow(
      "requires KUBERNETES_RUNTIME_CLASS=gvisor (found runsc)",
    );
    expect(() => assertPlatformConfig(autopilot, { runtimeClassName: "gvisor", maxDiskMb: 2048 })).not.toThrow();
  });

  it("refuses a CODING_MAX_DISK_MB that cannot fit the 10 GiB ephemeral-storage ceiling", () => {
    expect(() => assertPlatformConfig(autopilot, { runtimeClassName: "gvisor", maxDiskMb: 9216 })).not.toThrow();
    expect(() => assertPlatformConfig(autopilot, { runtimeClassName: "gvisor", maxDiskMb: 9217 })).toThrow(
      /CODING_MAX_DISK_MB=9217 needs 10241 MiB of pod ephemeral storage, over the 10240 MiB \(10 GiB\) ceiling/,
    );
  });
});

describe("normalizePlatformMetadata", () => {
  const view = () => ({
    labels: { "app.kubernetes.io/managed-by": "wardby", "autopilot.gke.io/injected": "yes" },
    annotations: {
      "wardby.io/run-id": "run-1",
      "autopilot.gke.io/resource-adjustment": "{}",
      "example.com/injected": "no",
    },
    spec: {
      containers: [],
      nodeSelector: { "sandbox.gke.io/runtime": "gvisor" },
      tolerations: [{ key: "sandbox.gke.io/runtime", operator: "Equal", value: "gvisor", effect: "NoSchedule" }],
    } as V1PodSpec,
  });

  it("tolerates nothing at all under generic", () => {
    const before = view();
    const after = view();
    normalizePlatformMetadata(generic, after);
    expect(after).toEqual(before);
  });

  it("removes exactly the metadata the Autopilot profile names", () => {
    const after = view();
    normalizePlatformMetadata(autopilot, after);
    expect(after.labels).toEqual({ "app.kubernetes.io/managed-by": "wardby" });
    expect(after.annotations).toEqual({ "wardby.io/run-id": "run-1", "example.com/injected": "no" });
    expect(after.spec.nodeSelector).toBeUndefined();
    expect(after.spec.tolerations).toBeUndefined();
  });

  it("keeps a toleration whose value differs from the profile's", () => {
    const after = view();
    after.spec.tolerations = [
      { key: "sandbox.gke.io/runtime", operator: "Equal", value: "other", effect: "NoSchedule" },
    ];
    normalizePlatformMetadata(autopilot, after);
    expect(after.spec.tolerations).toHaveLength(1);
  });

  it("keeps a nodeSelector entry whose value differs from the profile's", () => {
    const after = view();
    after.spec.nodeSelector = { "sandbox.gke.io/runtime": "none" };
    normalizePlatformMetadata(autopilot, after);
    expect(after.spec.nodeSelector).toEqual({ "sandbox.gke.io/runtime": "none" });
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx vitest run src/providers/jobs/kubernetes-platform.test.ts`
Expected: FAIL — `Failed to resolve import "./kubernetes-platform.js"`.

- [ ] **Step 3: Write the profiles module**

Create `src/providers/jobs/kubernetes-platform.ts`:

```ts
/**
 * Platform profiles for the Kubernetes coding launcher.
 *
 * A profile is pure data plus two pure functions. It answers exactly two
 * questions, and a reviewer can read the full answer to both in this file:
 *
 *  1. What resource values must the builder emit so the platform's admission
 *     controller has nothing left to rewrite? (`conformResources`)
 *  2. What does the platform stamp on the pod anyway, and is it in a named,
 *     bounded list? (`normalizePlatformMetadata`)
 *
 * Profiles narrow what counts as an *expected* difference. They never disable
 * the comparison: `normalizePlatformMetadata` deletes named keys from both the
 * submitted and the read-back pod, symmetrically, and everything else is still
 * deep-compared by kubernetes-isolation.ts. The `generic` profile's lists are
 * empty, so it tolerates nothing beyond what shipped before profiles existed.
 *
 * The Autopilot numbers come from Google's autopilot-resource-requests,
 * sandbox-pods, and autopilot-security documentation (checked 2026-09-22) and
 * are confirmed against a real cluster by the dry-run capture in
 * src/tools/capture-autopilot-dry-run.ts.
 */
import type { V1PodSpec, V1Toleration } from "@kubernetes/client-node";

export type KubernetesPlatform = "generic" | "gke-autopilot";
export const KUBERNETES_PLATFORMS: readonly KubernetesPlatform[] = ["generic", "gke-autopilot"];

export const KUBERNETES_PLATFORM_ERROR = "kubernetes_platform_unconformable";

/** A request the platform cannot legally run, refused here instead of being silently adjusted by the platform. */
export class KubernetesPlatformError extends Error {
  constructor(detail: string) {
    super(`${KUBERNETES_PLATFORM_ERROR}: ${detail}`);
    this.name = "KubernetesPlatformError";
  }
}

export const GVISOR_RUNTIME_CLASS = "gvisor";
/** Ephemeral storage the init container needs to create the three subPath roots. */
export const STORAGE_INIT_EPHEMERAL_MIB = 64;
/** Ephemeral storage reserved for the worker's writable layer (/tmp and /home are memory-backed). */
export const WORKER_EPHEMERAL_MIB = 1024;

export interface PlatformResourceRules {
  /** Smallest CPU request the platform accepts, in millicores. */
  cpuFloorMillicores: number;
  /** Granularity the platform rounds CPU up to, in millicores. */
  cpuIncrementMillicores: number;
  /** Lower edge of the memory:CPU band, in MiB of memory per whole CPU. */
  memoryPerCpuMinMib: number;
  /** Upper edge of the memory:CPU band, in MiB of memory per whole CPU. */
  memoryPerCpuMaxMib: number;
  /** Ceiling on the pod's total ephemeral storage, in MiB; undefined means the platform imposes none. */
  ephemeralStorageCeilingMib?: number;
  /** Whether the builder must emit explicit ephemeral-storage requests/limits on every container. */
  explicitEphemeralStorage: boolean;
}

export interface PlatformMetadataAllowance {
  /** Annotation key prefixes the platform's admission controller adds. */
  podAnnotationKeyPrefixes: readonly string[];
  /**
   * Label key prefixes the platform adds. Note run-pod labels are also the run
   * NetworkPolicy's podSelector: forgiving an *added* label is safe because it
   * cannot remove wardby's own labels, which still match the policy. A changed
   * or missing wardby label is a mismatch and still fails.
   */
  podLabelKeyPrefixes: readonly string[];
  /** Tolerations the platform's admission controller adds, matched field for field. */
  tolerations: readonly V1Toleration[];
  /** nodeSelector entries the platform adds, matched key and value. */
  nodeSelector: Readonly<Record<string, string>>;
  /** True when the platform strips the pod-level seccompProfile (sandboxed pods are exempt from its default). */
  dropsPodSeccompProfile: boolean;
}

export interface KubernetesPlatformProfile {
  name: KubernetesPlatform;
  resources: PlatformResourceRules;
  metadata: PlatformMetadataAllowance;
  /** gVisor is mandatory: an unset or different runtime class is refused at startup, not warned about. */
  requiresGvisor: boolean;
}

const NO_METADATA: PlatformMetadataAllowance = {
  podAnnotationKeyPrefixes: [],
  podLabelKeyPrefixes: [],
  tolerations: [],
  nodeSelector: {},
  dropsPodSeccompProfile: false,
};

const GENERIC: KubernetesPlatformProfile = {
  name: "generic",
  resources: {
    cpuFloorMillicores: 0,
    cpuIncrementMillicores: 1,
    memoryPerCpuMinMib: 0,
    memoryPerCpuMaxMib: Number.POSITIVE_INFINITY,
    explicitEphemeralStorage: false,
  },
  metadata: NO_METADATA,
  requiresGvisor: false,
};

const GKE_AUTOPILOT: KubernetesPlatformProfile = {
  name: "gke-autopilot",
  resources: {
    // General-purpose compute class: 0.25 vCPU minimum, 0.25 vCPU increments,
    // memory between 1 GiB and 6.5 GiB per vCPU, 10 GiB of ephemeral storage per Pod.
    cpuFloorMillicores: 250,
    cpuIncrementMillicores: 250,
    memoryPerCpuMinMib: 1024,
    memoryPerCpuMaxMib: 6656,
    ephemeralStorageCeilingMib: 10 * 1024,
    explicitEphemeralStorage: true,
  },
  metadata: {
    // autopilot.gke.io/* carries the resource-adjustment record and the warden version.
    podAnnotationKeyPrefixes: ["autopilot.gke.io/"],
    podLabelKeyPrefixes: ["autopilot.gke.io/"],
    // GKE adds the gVisor toleration itself for a pod with runtimeClassName: gvisor.
    tolerations: [
      { key: "sandbox.gke.io/runtime", operator: "Equal", value: GVISOR_RUNTIME_CLASS, effect: "NoSchedule" },
    ],
    nodeSelector: { "sandbox.gke.io/runtime": GVISOR_RUNTIME_CLASS },
    // We set seccompProfile: RuntimeDefault ourselves, and the sandbox exemption only means Autopilot
    // does not *add* one — so there is nothing to forgive. If a capture ever shows the field stripped,
    // flip this to true rather than widening anything else.
    dropsPodSeccompProfile: false,
  },
  requiresGvisor: true,
};

const PROFILES: Record<KubernetesPlatform, KubernetesPlatformProfile> = {
  generic: GENERIC,
  "gke-autopilot": GKE_AUTOPILOT,
};

export function platformProfile(name: KubernetesPlatform): KubernetesPlatformProfile {
  const profile = PROFILES[name];
  if (!profile) throw new KubernetesPlatformError(`unknown platform ${String(name)}`);
  return profile;
}

export interface ContainerResourceRequest {
  cpuMillicores: number;
  memoryMib: number;
  /** Required when the profile sets explicitEphemeralStorage. */
  ephemeralStorageMib?: number;
}

export interface ContainerResources {
  requests: Record<string, string>;
  limits: Record<string, string>;
}

/**
 * The resource block to emit for one container: the smallest values that both
 * satisfy the request and are already legal on the platform, so nothing is
 * rewritten after submission. Limits always equal requests (Autopilot sets them
 * equal anyway, and every wardby container has always been emitted that way).
 *
 * Conformance is monotone in one pass: CPU only ever rises (to the floor, to the
 * increment, and to whatever the memory:CPU ceiling demands), and raising CPU
 * only ever raises the ceiling and the floor it must satisfy.
 *
 * Per-container conformance is enough for the pod as a whole: multiples of the
 * CPU increment sum to a multiple of the increment, and the sum of several
 * ratios inside a band stays inside that band.
 */
export function conformResources(
  profile: KubernetesPlatformProfile,
  request: ContainerResourceRequest,
): ContainerResources {
  const rules = profile.resources;
  const increment = Math.max(1, rules.cpuIncrementMillicores);
  const cpuForMemory = Number.isFinite(rules.memoryPerCpuMaxMib)
    ? Math.ceil((request.memoryMib / rules.memoryPerCpuMaxMib) * 1000)
    : 0;
  const wanted = Math.max(request.cpuMillicores, cpuForMemory, rules.cpuFloorMillicores);
  const cpuMillicores = Math.ceil(wanted / increment) * increment;
  const memoryMib = Math.max(request.memoryMib, Math.ceil((cpuMillicores / 1000) * rules.memoryPerCpuMinMib));
  const requests: Record<string, string> = { cpu: `${cpuMillicores}m`, memory: `${memoryMib}Mi` };
  if (rules.explicitEphemeralStorage) {
    if (request.ephemeralStorageMib === undefined) {
      throw new KubernetesPlatformError(
        `platform ${profile.name} requires an explicit ephemeral-storage request on every container`,
      );
    }
    requests["ephemeral-storage"] = `${request.ephemeralStorageMib}Mi`;
  }
  return { requests, limits: { ...requests } };
}

/**
 * The pod's total ephemeral storage: max(init containers) + sum(regular containers).
 * storage-init's 64 MiB never exceeds keeper + worker, so the total is the keeper's
 * storage volume plus the worker's reservation.
 */
export function podEphemeralStorageMib(diskMb: number): number {
  return diskMb + WORKER_EPHEMERAL_MIB;
}

function tolerationMatches(actual: V1Toleration, allowed: V1Toleration): boolean {
  return (
    actual.key === allowed.key &&
    actual.operator === allowed.operator &&
    actual.value === allowed.value &&
    actual.effect === allowed.effect &&
    actual.tolerationSeconds === allowed.tolerationSeconds
  );
}

function stripPrefixed(bag: Record<string, string>, prefixes: readonly string[]): void {
  for (const key of Object.keys(bag)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) delete bag[key];
  }
}

/**
 * Deletes exactly the metadata this platform is known to add. Called on BOTH
 * sides of the comparison: the submitted pod never carries any of it, so the
 * deletion is a no-op there, and the read-back pod loses only what is named
 * here. Nothing else is touched, so any other difference still fails the run.
 */
export function normalizePlatformMetadata(
  profile: KubernetesPlatformProfile,
  view: { labels: Record<string, string>; annotations: Record<string, string>; spec: V1PodSpec },
): void {
  const { metadata } = profile;
  stripPrefixed(view.annotations, metadata.podAnnotationKeyPrefixes);
  stripPrefixed(view.labels, metadata.podLabelKeyPrefixes);
  if (metadata.tolerations.length > 0 && view.spec.tolerations) {
    const remaining = view.spec.tolerations.filter(
      (toleration) => !metadata.tolerations.some((allowed) => tolerationMatches(toleration, allowed)),
    );
    if (remaining.length === 0) delete view.spec.tolerations;
    else view.spec.tolerations = remaining;
  }
  const selector = view.spec.nodeSelector;
  if (selector) {
    for (const [key, value] of Object.entries(metadata.nodeSelector)) {
      if (selector[key] === value) delete selector[key];
    }
    if (Object.keys(selector).length === 0) delete view.spec.nodeSelector;
  }
  if (metadata.dropsPodSeccompProfile && view.spec.securityContext) delete view.spec.securityContext.seccompProfile;
}

export interface PlatformConfigCheck {
  runtimeClassName?: string;
  /** The effective CODING_MAX_DISK_MB: the largest workspace an agents:write caller may request. */
  maxDiskMb: number;
}

/**
 * Refuses a configuration that cannot work on this platform, at startup rather
 * than at the first coding run. Each message names the setting and the limit.
 */
export function assertPlatformConfig(profile: KubernetesPlatformProfile, config: PlatformConfigCheck): void {
  if (profile.requiresGvisor && config.runtimeClassName !== GVISOR_RUNTIME_CLASS) {
    throw new KubernetesPlatformError(
      `KUBERNETES_PLATFORM=${profile.name} requires KUBERNETES_RUNTIME_CLASS=${GVISOR_RUNTIME_CLASS} (found ${config.runtimeClassName ?? "unset"})`,
    );
  }
  const ceiling = profile.resources.ephemeralStorageCeilingMib;
  if (ceiling !== undefined) {
    const total = podEphemeralStorageMib(config.maxDiskMb);
    if (total > ceiling) {
      throw new KubernetesPlatformError(
        `CODING_MAX_DISK_MB=${config.maxDiskMb} needs ${total} MiB of pod ephemeral storage, over the ${ceiling} MiB (10 GiB) ceiling of KUBERNETES_PLATFORM=${profile.name}; the worker container reserves ${WORKER_EPHEMERAL_MIB} MiB of that, so the largest workspace this platform can run is ${ceiling - WORKER_EPHEMERAL_MIB} MiB`,
      );
    }
  }
}
```

- [ ] **Step 4: Run the profile tests**

Run: `npx vitest run src/providers/jobs/kubernetes-platform.test.ts`
Expected: PASS (all assertions above).

- [ ] **Step 5: Write the failing config test**

Append to `src/config/providers.test.ts`:

```ts
describe("loadKubernetesJobConfig", () => {
  it("defaults to the generic platform and leaves the timeouts unset", () => {
    const config = loadKubernetesJobConfig({});
    expect(config.platform).toBe("generic");
    expect(config.preflightTimeoutMs).toBeUndefined();
    expect(config.readyTimeoutMs).toBeUndefined();
  });

  it("accepts gke-autopilot", () => {
    expect(loadKubernetesJobConfig({ KUBERNETES_PLATFORM: "gke-autopilot" }).platform).toBe("gke-autopilot");
  });

  it("rejects an unknown platform", () => {
    expect(() => loadKubernetesJobConfig({ KUBERNETES_PLATFORM: "eks" })).toThrow(
      "KUBERNETES_PLATFORM must be one of: generic, gke-autopilot.",
    );
  });

  it("reads the two cluster timeouts as bounded integers", () => {
    const config = loadKubernetesJobConfig({
      KUBERNETES_PREFLIGHT_TIMEOUT_MS: "600000",
      KUBERNETES_READY_TIMEOUT_MS: "600000",
    });
    expect(config.preflightTimeoutMs).toBe(600_000);
    expect(config.readyTimeoutMs).toBe(600_000);
    expect(() => loadKubernetesJobConfig({ KUBERNETES_READY_TIMEOUT_MS: "10" })).toThrow(
      "KUBERNETES_READY_TIMEOUT_MS must be an integer between 1000 and 900000.",
    );
  });
});
```

- [ ] **Step 6: Run it to watch it fail**

Run: `npx vitest run src/config/providers.test.ts -t loadKubernetesJobConfig`
Expected: FAIL — `platform` is `undefined`.

- [ ] **Step 7: Add the settings**

In `src/config/providers.ts`, import the type and extend the config (lines 167–185):

```ts
import { KUBERNETES_PLATFORMS, type KubernetesPlatform } from "../providers/jobs/kubernetes-platform.js";
```

```ts
/** JOB_LAUNCHER=kubernetes: where coding-run pods go, how they reach the in-cluster proxy, and which platform's admission rules apply. */
export interface KubernetesJobConfig {
  namespace: string;
  context?: string;
  proxyService: string;
  runtimeClassName?: string;
  platform: KubernetesPlatform;
  /**
   * Bound for the whole cluster preflight (canary pod scheduling included) and for how long a
   * launch waits for the keeper. Both default to the launcher's own values (90 s / 120 s), which
   * a cold managed cluster scheduling a sandboxed pod and pulling an image routinely exceeds.
   */
  preflightTimeoutMs?: number;
  readyTimeoutMs?: number;
}

export function loadKubernetesJobConfig(env: NodeJS.ProcessEnv = process.env): KubernetesJobConfig {
  const platform = (env.KUBERNETES_PLATFORM ?? "generic") as KubernetesPlatform;
  if (!KUBERNETES_PLATFORMS.includes(platform)) {
    throw new Error(`KUBERNETES_PLATFORM must be one of: ${KUBERNETES_PLATFORMS.join(", ")}.`);
  }
  const config: KubernetesJobConfig = {
    namespace: dnsLabel(env.KUBERNETES_NAMESPACE, "KUBERNETES_NAMESPACE", "wardby-coding"),
    proxyService: dnsLabel(env.KUBERNETES_PROXY_SERVICE, "KUBERNETES_PROXY_SERVICE", "wardby-coding-proxy"),
    platform,
  };
  if (env.KUBERNETES_CONTEXT) config.context = env.KUBERNETES_CONTEXT;
  if (env.KUBERNETES_RUNTIME_CLASS) {
    config.runtimeClassName = dnsLabel(env.KUBERNETES_RUNTIME_CLASS, "KUBERNETES_RUNTIME_CLASS", "");
  }
  const preflightTimeoutMs = optionalBoundedInteger(
    env.KUBERNETES_PREFLIGHT_TIMEOUT_MS,
    "KUBERNETES_PREFLIGHT_TIMEOUT_MS",
    1_000,
    900_000,
  );
  const readyTimeoutMs = optionalBoundedInteger(
    env.KUBERNETES_READY_TIMEOUT_MS,
    "KUBERNETES_READY_TIMEOUT_MS",
    1_000,
    900_000,
  );
  if (preflightTimeoutMs !== undefined) config.preflightTimeoutMs = preflightTimeoutMs;
  if (readyTimeoutMs !== undefined) config.readyTimeoutMs = readyTimeoutMs;
  return config;
}
```

- [ ] **Step 8: Plumb the timeouts through**

In `src/providers/executor/composition.ts`, in the `KubernetesJobLauncher` construction:

```ts
      readyTimeoutMs: kubernetes.readyTimeoutMs,
      preflight: async () => {
        const { proxyIp } = await runKubernetesPreflight({
          api,
          config: kubernetes,
          workerImage,
          timeoutMs: kubernetes.preflightTimeoutMs,
        });
        return { proxyIp };
      },
```

(`KubernetesJobLauncherOptions.readyTimeoutMs` and `KubernetesPreflightOptions.timeoutMs` already exist and already fall back to their defaults when `undefined`.)

In `src/cli.ts`'s kubernetes preflight branch:

```ts
checks = await kubernetesPreflight({
  api,
  config: kubernetes,
  workerImage: container.workerImage,
  timeoutMs: kubernetes.preflightTimeoutMs,
});
```

- [ ] **Step 9: Fix the config literals in the tests**

Every `KubernetesJobConfig` literal now needs `platform: "generic"`. There are three in `src/providers/jobs/kubernetes.test.ts` (the `harness` config at line ~82, the launcher at line ~418, and `clockedLauncher`'s at line ~750) and one `config` constant in `src/providers/jobs/kubernetes-preflight.test.ts` (line 15). `npm run typecheck` names any that are missed.

- [ ] **Step 10: Run the full suite and commit**

```bash
npm run typecheck && npm run lint && npm test && npm run format:check
git add src/providers/jobs/kubernetes-platform.ts src/providers/jobs/kubernetes-platform.test.ts \
  src/config/providers.ts src/config/providers.test.ts src/providers/executor/composition.ts src/cli.ts \
  src/providers/jobs/kubernetes.test.ts src/providers/jobs/kubernetes-preflight.test.ts
git commit -m "$(cat <<'EOF'
feat(kubernetes): add platform profiles and settable cluster timeouts

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 5: Conform resources in the builder and compare through the profile

**Files:**

- Modify: `src/providers/jobs/kubernetes-isolation.ts` (`RunPodOptions`, `buildRunPod` lines 160–249, `normalizePod` lines 435–448, `assertRunPodMatches` lines 463–467)
- Test: `src/providers/jobs/kubernetes-isolation.test.ts`
- Modify: `src/providers/jobs/kubernetes.ts` (`provision`), `src/providers/jobs/kubernetes-preflight.ts` (`runCanary`)

**Interfaces:**

- Consumes (Task 4): `conformResources`, `podEphemeralStorageMib`, `normalizePlatformMetadata`, `platformProfile`, `KubernetesPlatformError`, `STORAGE_INIT_EPHEMERAL_MIB`, `WORKER_EPHEMERAL_MIB`, `type KubernetesPlatform`, `type KubernetesPlatformProfile`.
- Produces:
  - `interface RunPodOptions { namespace: string; proxyIp: string; runtimeClassName?: string; platform?: KubernetesPlatform }` (`platform` defaults to `"generic"`)
  - `assertRunPodMatches(actual: V1Pod, expected: V1Pod, platform?: KubernetesPlatform): void` (defaults to `"generic"`)

**Security note:** the comparator's third parameter defaults to `generic`, so any caller that forgets it gets the strictest behaviour. `normalizePlatformMetadata` runs inside `normalizePod`, i.e. on both operands of the same deep comparison.

**Behaviour change to call out in the PR:** CPU is now always emitted in millicore form (`"1000m"` rather than `"1"`) and memory in MiB, on every platform — including existing Kubernetes deployments. These are the same quantities (the comparator has always normalized them to millicores and bytes), but the submitted YAML differs.

- [ ] **Step 1: Write the failing builder test**

In `src/providers/jobs/kubernetes-isolation.test.ts`, update the existing resource assertion (lines 216–217) to the millicore form and add a new `describe`:

```ts
expect(worker(pod()).resources).toEqual({
  requests: { cpu: "1000m", memory: "2048Mi" },
  limits: { cpu: "1000m", memory: "2048Mi" },
});
```

```ts
describe("buildRunPod under the gke-autopilot platform", () => {
  const autopilotOptions = { ...options, platform: "gke-autopilot" as const, runtimeClassName: "gvisor" };
  const autopilotPod = () => buildRunPod(spec, autopilotOptions);

  it("emits Autopilot-legal resources for every container", () => {
    const p = autopilotPod();
    expect(worker(p).resources).toEqual({
      requests: { cpu: "1000m", memory: "2048Mi", "ephemeral-storage": "1024Mi" },
      limits: { cpu: "1000m", memory: "2048Mi", "ephemeral-storage": "1024Mi" },
    });
    // 250m with 128Mi is below Autopilot's 1 GiB-per-vCPU floor; memory rises rather than being rewritten.
    expect(keeper(p).resources).toEqual({
      requests: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "2048Mi" },
      limits: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "2048Mi" },
    });
    expect(storageInit(p).resources).toEqual({
      requests: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "64Mi" },
      limits: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "64Mi" },
    });
  });

  it("still emits nothing extra under generic", () => {
    expect(keeper(pod()).resources).toEqual({
      requests: { cpu: "250m", memory: "128Mi" },
      limits: { cpu: "250m", memory: "128Mi" },
    });
  });

  it("refuses a workspace that cannot fit the 10 GiB pod ephemeral-storage ceiling", () => {
    const big: JobSpec = { ...spec, limits: { ...spec.limits, diskMb: 16_384 } };
    expect(() => buildRunPod(big, autopilotOptions)).toThrow(
      /kubernetes_platform_unconformable: a 16384 MiB workspace needs 17408 MiB of pod ephemeral storage, over the 10240 MiB \(10 GiB\) ceiling/,
    );
    expect(() => buildRunPod({ ...spec, limits: { ...spec.limits, diskMb: 9216 } }, autopilotOptions)).not.toThrow();
  });

  it("builds the same pod under generic regardless of the ceiling", () => {
    const big: JobSpec = { ...spec, limits: { ...spec.limits, diskMb: 16_384 } };
    expect(() => buildRunPod(big, options)).not.toThrow();
  });
});

describe("assertRunPodMatches with a platform profile", () => {
  const autopilotOptions = { ...options, platform: "gke-autopilot" as const, runtimeClassName: "gvisor" };

  it("forgives the Autopilot annotations, nodeSelector and toleration under gke-autopilot", () => {
    const expected = buildRunPod(spec, autopilotOptions);
    const actual = structuredClone(expected);
    actual.metadata!.annotations!["autopilot.gke.io/resource-adjustment"] = "{}";
    actual.spec!.nodeSelector = { "sandbox.gke.io/runtime": "gvisor" };
    actual.spec!.tolerations = [
      { key: "sandbox.gke.io/runtime", operator: "Equal", value: "gvisor", effect: "NoSchedule" },
    ];
    expect(() => assertRunPodMatches(actual, expected, "gke-autopilot")).not.toThrow();
  });

  it("rejects those same additions under generic, including by default", () => {
    const expected = buildRunPod(spec, autopilotOptions);
    const actual = structuredClone(expected);
    actual.spec!.nodeSelector = { "sandbox.gke.io/runtime": "gvisor" };
    expect(() => assertRunPodMatches(actual, expected, "generic")).toThrow(KUBERNETES_ISOLATION_ERROR);
    expect(() => assertRunPodMatches(actual, expected)).toThrow(KUBERNETES_ISOLATION_ERROR);
  });

  it("still rejects a security-relevant change under gke-autopilot", () => {
    const expected = buildRunPod(spec, autopilotOptions);
    for (const tamper of [
      (p: V1Pod) => void (p.spec!.hostNetwork = true),
      (p: V1Pod) => void (p.spec!.automountServiceAccountToken = true),
      (p: V1Pod) => void (worker(p).securityContext!.readOnlyRootFilesystem = false),
      (p: V1Pod) => void (worker(p).command = ["node", "-e", "evil"]),
      (p: V1Pod) => void (p.metadata!.annotations!["example.com/x"] = "1"),
      (p: V1Pod) => void (worker(p).resources!.limits!["ephemeral-storage"] = "8192Mi"),
    ]) {
      const actual = structuredClone(expected);
      actual.metadata!.annotations!["autopilot.gke.io/resource-adjustment"] = "{}";
      tamper(actual);
      expect(() => assertRunPodMatches(actual, expected, "gke-autopilot")).toThrow(KUBERNETES_ISOLATION_ERROR);
    }
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx vitest run src/providers/jobs/kubernetes-isolation.test.ts`
Expected: FAIL — `buildRunPod` does not accept `platform` and `assertRunPodMatches` takes two arguments.

- [ ] **Step 3: Conform the builder**

In `src/providers/jobs/kubernetes-isolation.ts`, add the imports and rewrite the resource blocks of `buildRunPod`:

```ts
import {
  KubernetesPlatformError,
  STORAGE_INIT_EPHEMERAL_MIB,
  WORKER_EPHEMERAL_MIB,
  conformResources,
  normalizePlatformMetadata,
  platformProfile,
  podEphemeralStorageMib,
  type KubernetesPlatform,
  type KubernetesPlatformProfile,
} from "./kubernetes-platform.js";
```

```ts
export interface RunPodOptions {
  namespace: string;
  proxyIp: string;
  runtimeClassName?: string;
  /** Which platform's admission rules the emitted resources must already satisfy. Default: "generic". */
  platform?: KubernetesPlatform;
}

export function buildRunPod(spec: JobSpec, options: RunPodOptions): V1Pod {
  validateKubernetesSpec(spec);
  const profile = platformProfile(options.platform ?? "generic");
  const ceiling = profile.resources.ephemeralStorageCeilingMib;
  const podEphemeral = podEphemeralStorageMib(spec.limits.diskMb);
  if (ceiling !== undefined && podEphemeral > ceiling) {
    throw new KubernetesPlatformError(
      `a ${spec.limits.diskMb} MiB workspace needs ${podEphemeral} MiB of pod ephemeral storage, over the ${ceiling} MiB (10 GiB) ceiling of platform ${profile.name}`,
    );
  }
  const names = kubernetesRunNames(spec.runId);
  const scratchMb = Math.max(16, Math.min(64, Math.floor(spec.limits.memoryMb / 8)));
  const sidecarCpuMillicores = 250;
  const sidecarMemoryMib = 128;
```

Then replace each container's `resources` line:

```ts
    resources: conformResources(profile, {
      cpuMillicores: sidecarCpuMillicores,
      memoryMib: sidecarMemoryMib,
      ephemeralStorageMib: STORAGE_INIT_EPHEMERAL_MIB,
    }),
```

```ts
    resources: conformResources(profile, {
      cpuMillicores: sidecarCpuMillicores,
      memoryMib: sidecarMemoryMib,
      // The keeper owns the storage volume: seeding and collection stream through it.
      ephemeralStorageMib: spec.limits.diskMb,
    }),
```

```ts
    resources: conformResources(profile, {
      cpuMillicores: Math.round(spec.limits.cpus * 1000),
      memoryMib: spec.limits.memoryMb,
      ephemeralStorageMib: WORKER_EPHEMERAL_MIB,
    }),
```

- [ ] **Step 4: Thread the profile through the comparator**

Replace `normalizePod` and `assertRunPodMatches`:

```ts
function normalizePod(
  pod: V1Pod,
  profile: KubernetesPlatformProfile,
): { labels: Record<string, string>; annotations: Record<string, string>; spec: V1PodSpec } {
  if (!pod.spec) throw isolationError();
  const spec = structuredClone(pod.spec);
  normalizeSpec(spec);
  const view = {
    labels: structuredClone(pod.metadata?.labels ?? {}),
    annotations: structuredClone(pod.metadata?.annotations ?? {}),
    spec,
  };
  // Applied to BOTH operands, symmetrically: deletes only the keys the profile names,
  // and the profile for "generic" names none.
  normalizePlatformMetadata(profile, view);
  return view;
}

export function assertRunPodMatches(actual: V1Pod, expected: V1Pod, platform: KubernetesPlatform = "generic"): void {
  const profile = platformProfile(platform);
  const a = canonical(normalizePod(actual, profile));
  const e = canonical(normalizePod(expected, profile));
  if (JSON.stringify(a) !== JSON.stringify(e)) throw isolationError();
}
```

- [ ] **Step 5: Run the isolation tests**

Run: `npx vitest run src/providers/jobs/kubernetes-isolation.test.ts`
Expected: PASS.

- [ ] **Step 6: Pass the platform from the launcher and the canary**

In `src/providers/jobs/kubernetes.ts`'s `provision`, destructure the platform and use it in both places:

```ts
const { runtimeClassName, proxyService, platform } = this.options.config;
```

```ts
const pod = buildRunPod(spec, { namespace: this.namespace, proxyIp, runtimeClassName, platform });
```

```ts
assertRunPodMatches(actualPod, pod, platform);
```

In `src/providers/jobs/kubernetes-preflight.ts`'s `runCanary`:

```ts
const pod = buildRunPod(spec, {
  namespace,
  proxyIp,
  runtimeClassName: config.runtimeClassName,
  platform: config.platform,
});
```

- [ ] **Step 7: Run the full suite and commit**

```bash
npm run typecheck && npm run lint && npm test && npm run format:check
git add src/providers/jobs/kubernetes-isolation.ts src/providers/jobs/kubernetes-isolation.test.ts \
  src/providers/jobs/kubernetes.ts src/providers/jobs/kubernetes-preflight.ts
git commit -m "$(cat <<'EOF'
feat(kubernetes): emit platform-conformant resources and compare through the profile

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 6: Startup refusals under gke-autopilot

**Files:**

- Modify: `src/providers/jobs/kubernetes-preflight.ts` (`KubernetesPreflightOptions`, `runChecks`)
- Test: `src/providers/jobs/kubernetes-preflight.test.ts`
- Modify: `src/providers/executor/composition.ts` (the kubernetes branch)
- Test: `src/providers/executor/composition.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**

- Consumes: `assertPlatformConfig`, `platformProfile` (Task 4); `ContainerExecutorConfig.maxDiskMb` (`src/config/providers.ts`).
- Produces: `KubernetesPreflightOptions.maxDiskMb: number` (**required**); preflight check list `["platform", "namespace", "proxy-service", "worker-image", "canary"]`.

- [ ] **Step 1: Write the failing tests**

In `src/providers/jobs/kubernetes-preflight.test.ts`:

```ts
it("refuses an autopilot configuration without gvisor, before touching the cluster", async () => {
  const api = cluster(ok);
  const reads: string[] = [];
  api.readService = async () => {
    reads.push("service");
    return undefined;
  };
  await expect(
    kubernetesPreflight({
      api,
      config: { ...config, platform: "gke-autopilot" },
      workerImage: IMAGE,
      maxDiskMb: 2048,
      sleep: async () => {},
    }),
  ).rejects.toThrow("kubernetes_isolation_unsupported:platform");
  expect(reads).toEqual([]);
});

it("refuses a CODING_MAX_DISK_MB over the autopilot ceiling and names the cap", async () => {
  const error = await kubernetesPreflight({
    api: cluster(ok),
    config: { ...config, platform: "gke-autopilot", runtimeClassName: "gvisor" },
    workerImage: IMAGE,
    maxDiskMb: 16_384,
    sleep: async () => {},
  }).catch((e: unknown) => e);
  expect(describePreflightFailure(error)).toContain("over the 10240 MiB (10 GiB) ceiling");
});

it("reports platform first among the passing checks", async () => {
  expect(
    await kubernetesPreflight({
      api: cluster(ok),
      config,
      workerImage: IMAGE,
      maxDiskMb: 2048,
      sleep: async () => {},
    }),
  ).toEqual(["platform", "namespace", "proxy-service", "worker-image", "canary"]);
});
```

In `src/providers/executor/composition.test.ts`:

```ts
it("refuses to compose a kubernetes launcher on gke-autopilot without gvisor", () => {
  expect(() =>
    buildConfiguredExecutor({
      native: noopExecutor(),
      db: prismaStub,
      kubernetesApi: new FakeKubernetesApi(),
      env: {
        ...baseEnv,
        JOB_LAUNCHER: "kubernetes",
        KUBERNETES_PLATFORM: "gke-autopilot",
        CODING_WORKER_IMAGE: IMAGE,
      },
    }),
  ).toThrow("requires KUBERNETES_RUNTIME_CLASS=gvisor (found unset)");
});
```

(Follow the existing arrangement of that file for `noopExecutor`, `prismaStub`, and `baseEnv`; if the file has no such helpers, model the call on the existing `buildConfiguredExecutor` tests there.)

- [ ] **Step 2: Run them to watch them fail**

Run: `npx vitest run src/providers/jobs/kubernetes-preflight.test.ts src/providers/executor/composition.test.ts`
Expected: FAIL — `maxDiskMb` is not an option and no `platform` check exists.

- [ ] **Step 3: Add the preflight check**

In `src/providers/jobs/kubernetes-preflight.ts`:

```ts
import { assertPlatformConfig, platformProfile } from "./kubernetes-platform.js";
```

```ts
export interface KubernetesPreflightOptions {
  api: KubernetesApi;
  config: KubernetesJobConfig;
  workerImage: string; // registry digest
  /** The effective CODING_MAX_DISK_MB; the platform check refuses a value the platform cannot run. */
  maxDiskMb: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number; // default 90_000; bounds the whole preflight
  cleanupTimeoutMs?: number; // default 15_000; bounds each canary delete
}
```

At the top of `runChecks`, before any cluster read:

```ts
const { api, config, workerImage } = options;

// Pure configuration, checked first: a deployment that cannot work is refused before
// a single API call, with a message naming the setting and the limit.
await runCheck("platform", async () => {
  assertPlatformConfig(platformProfile(config.platform), {
    runtimeClassName: config.runtimeClassName,
    maxDiskMb: options.maxDiskMb,
  });
});
passed.push("platform");
```

Because `maxDiskMb` is required, **every** existing `kubernetesPreflight`/`runKubernetesPreflight` call must now pass it: the three production call sites below, plus every call in `kubernetes-preflight.test.ts` and the one in `kubernetes.integration.test.ts` (Task 8 updates that file anyway). `npm run typecheck` names each one.

- [ ] **Step 4: Refuse at composition time too**

In `src/providers/executor/composition.ts`, inside the `providerConfig.jobs === "kubernetes"` branch, right after `const kubernetes = loadKubernetesJobConfig(env);`:

```ts
// The preflight only runs on the first launch; a configuration that cannot work should
// fail the process at start-up, not the first coding run an hour later.
assertPlatformConfig(platformProfile(kubernetes.platform), {
  runtimeClassName: kubernetes.runtimeClassName,
  maxDiskMb: config.maxDiskMb,
});
```

and add `maxDiskMb` to the preflight call added in Task 4 step 8:

```ts
const { proxyIp } = await runKubernetesPreflight({
  api,
  config: kubernetes,
  workerImage,
  maxDiskMb: config.maxDiskMb,
  timeoutMs: kubernetes.preflightTimeoutMs,
});
```

Add `import { assertPlatformConfig, platformProfile } from "../jobs/kubernetes-platform.js";`.

- [ ] **Step 5: Pass it from the CLI**

In `src/cli.ts`'s kubernetes preflight branch:

```ts
checks = await kubernetesPreflight({
  api,
  config: kubernetes,
  workerImage: container.workerImage,
  maxDiskMb: container.maxDiskMb,
  timeoutMs: kubernetes.preflightTimeoutMs,
});
```

- [ ] **Step 6: Run the affected tests**

Run: `npx vitest run src/providers/jobs/kubernetes-preflight.test.ts src/providers/executor/composition.test.ts`
Expected: PASS.

- [ ] **Step 7: Update the documentation**

In `docs/coding-worker-isolation.md`'s `### Preflight` section, add `platform` as check 1 (and renumber): pure configuration, refused before any API call — under `gke-autopilot` the runtime class must be `gvisor` and `CODING_MAX_DISK_MB` must leave room for the worker's 1 GiB reservation inside Autopilot's 10 GiB pod ceiling. Say "five checks in order" again.

- [ ] **Step 8: Full verification and commit**

```bash
npm run typecheck && npm run lint && npm test && npm run format:check
git add src/providers/jobs/kubernetes-preflight.ts src/providers/jobs/kubernetes-preflight.test.ts \
  src/providers/executor/composition.ts src/providers/executor/composition.test.ts src/cli.ts \
  docs/coding-worker-isolation.md
git commit -m "$(cat <<'EOF'
feat(kubernetes): refuse an unrunnable autopilot configuration at startup

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 7: The dry-run capture tool and the committed fixture

**Files:**

- Modify: `src/providers/jobs/kubernetes-api.ts`, `src/providers/jobs/kubernetes-client.ts`, `src/providers/jobs/fake-kubernetes-api.ts`
- Test: `src/providers/jobs/fake-kubernetes-api.test.ts`
- Create: `src/providers/jobs/kubernetes-dry-run-fixture.ts`
- Test: `src/providers/jobs/kubernetes-dry-run-fixture.test.ts`
- Create: `src/providers/jobs/fixtures/gke-autopilot-dry-run.json`
- Test: `src/providers/jobs/kubernetes-autopilot-attestation.test.ts`
- Create: `src/tools/capture-autopilot-dry-run.ts`
- Modify: `package.json` (one script)

**Interfaces:**

- Consumes: `buildRunPod`, `assertRunPodMatches` (Task 5); `readProxyWitness` (Task 2); `loadKubernetesJobConfig`, `loadContainerExecutorConfig` (Task 4).
- Produces:
  - `KubernetesApi.dryRunCreatePod(namespace: string, body: V1Pod): Promise<V1Pod>`
  - From `kubernetes-dry-run-fixture.ts`: `interface PodMutation { op: "add" | "replace" | "remove"; path: string; value?: unknown }`, `interface DryRunFixture { capturedAt: string; platform: KubernetesPlatform; provisional: boolean; source: string; notes: string[]; mutations: PodMutation[] }`, `applyMutations<T>(document: T, mutations: readonly PodMutation[]): T`, `diffMutations(before: unknown, after: unknown, prefix?: string): PodMutation[]`, `loadDryRunFixture(): DryRunFixture`
  - npm script `capture:autopilot`

**Security note:** the dry run is a development tool, never a runtime authority. Nothing in the launcher or the preflight calls `dryRunCreatePod`; the admission chain that produces these mutations is the same one an attacker with cluster access would subvert, so it may not bless itself at launch time. The committed fixture is reviewed in a diff, exactly like the pricing tables.

- [ ] **Step 1: Write the failing fixture-machinery test**

Create `src/providers/jobs/kubernetes-dry-run-fixture.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyMutations, diffMutations, loadDryRunFixture } from "./kubernetes-dry-run-fixture.js";

describe("applyMutations", () => {
  it("adds, replaces and removes by JSON Pointer, unescaping ~1 and ~0", () => {
    const document = { metadata: { annotations: { keep: "1", drop: "2" } }, spec: { containers: [{ name: "a" }] } };
    expect(
      applyMutations(document, [
        { op: "add", path: "/metadata/annotations/autopilot.gke.io~1warden-version", value: "v1" },
        { op: "replace", path: "/spec/containers/0/name", value: "b" },
        { op: "remove", path: "/metadata/annotations/drop" },
      ]),
    ).toEqual({
      metadata: { annotations: { keep: "1", "autopilot.gke.io/warden-version": "v1" } },
      spec: { containers: [{ name: "b" }] },
    });
  });

  it("does not mutate its input", () => {
    const document = { a: 1 };
    applyMutations(document, [{ op: "replace", path: "/a", value: 2 }]);
    expect(document).toEqual({ a: 1 });
  });

  it("throws on a path that does not resolve", () => {
    expect(() => applyMutations({ a: 1 }, [{ op: "replace", path: "/b/c", value: 2 }])).toThrow("dry_run_fixture_path");
  });
});

describe("diffMutations", () => {
  it("round-trips: applying the diff to `before` reproduces `after`", () => {
    const before = { metadata: { annotations: { keep: "1" } }, spec: { tolerations: undefined as unknown } };
    const after = {
      metadata: { annotations: { keep: "1", "autopilot.gke.io/x": "y" } },
      spec: { tolerations: [{ key: "k" }] },
    };
    const mutations = diffMutations(before, after);
    expect(applyMutations(before, mutations)).toEqual(after);
  });
});

describe("loadDryRunFixture", () => {
  it("loads the committed Autopilot capture", () => {
    const fixture = loadDryRunFixture();
    expect(fixture.platform).toBe("gke-autopilot");
    expect(fixture.mutations.length).toBeGreaterThan(0);
    expect(typeof fixture.provisional).toBe("boolean");
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx vitest run src/providers/jobs/kubernetes-dry-run-fixture.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the fixture machinery**

Create `src/providers/jobs/kubernetes-dry-run-fixture.ts`:

```ts
/**
 * The recorded Autopilot admission mutations, and the two pure functions that
 * produce and replay them.
 *
 * The fixture stores a *mutation list*, not a pair of whole pods, for two
 * reasons: a reviewer can read the entire set of differences the platform
 * introduces in a few lines, and the test rebuilds the submitted pod from the
 * live builder, so the fixture cannot quietly go stale against it.
 *
 * `provisional` is true while the file is written from documentation rather
 * than captured from a cluster. The attestation suite names that state in its
 * report, so a forgotten capture cannot pass unnoticed.
 *
 * This is development data reviewed in a diff, never a runtime authority: the
 * launcher never asks a cluster what it is allowed to change.
 */
import { readFileSync } from "node:fs";
import type { KubernetesPlatform } from "./kubernetes-platform.js";

export interface PodMutation {
  op: "add" | "replace" | "remove";
  /** JSON Pointer (RFC 6901): "/" separated, with ~1 for "/" and ~0 for "~". */
  path: string;
  value?: unknown;
}

export interface DryRunFixture {
  capturedAt: string;
  platform: KubernetesPlatform;
  /** True until a real server-side dry run replaces this file. */
  provisional: boolean;
  source: string;
  notes: string[];
  mutations: PodMutation[];
}

const FIXTURE_URL = new URL("./fixtures/gke-autopilot-dry-run.json", import.meta.url);

export function loadDryRunFixture(): DryRunFixture {
  return JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as DryRunFixture;
}

function segments(path: string): string[] {
  if (path === "" || !path.startsWith("/")) throw new Error(`dry_run_fixture_path: ${path}`);
  return path
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

type Bag = Record<string, unknown> | unknown[];

function container(root: unknown, path: string[]): Bag {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== "object") throw new Error(`dry_run_fixture_path: /${path.join("/")}`);
    node = (node as Record<string, unknown>)[key];
  }
  if (node === null || typeof node !== "object") throw new Error(`dry_run_fixture_path: /${path.join("/")}`);
  return node as Bag;
}

/** Returns a copy of `document` with every mutation applied in order. */
export function applyMutations<T>(document: T, mutations: readonly PodMutation[]): T {
  const copy = structuredClone(document);
  for (const mutation of mutations) {
    const path = segments(mutation.path);
    const key = path.pop()!;
    const parent = container(copy, path) as Record<string, unknown>;
    if (mutation.op === "remove") delete parent[key];
    else parent[key] = structuredClone(mutation.value);
  }
  return copy;
}

function escape(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * The mutations that turn `before` into `after`. Objects are walked key by key;
 * anything else (including arrays) is replaced wholesale, which keeps a
 * toleration list or a container list readable as one op.
 */
export function diffMutations(before: unknown, after: unknown, prefix = ""): PodMutation[] {
  const plain = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!plain(before) || !plain(after)) {
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ op: "replace", path: prefix, value: after }];
  }
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  const mutations: PodMutation[] = [];
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const path = `${prefix}/${escape(key)}`;
    if (!(key in right) || right[key] === undefined) {
      if (left[key] !== undefined) mutations.push({ op: "remove", path });
    } else if (!(key in left) || left[key] === undefined) {
      mutations.push({ op: "add", path, value: right[key] });
    } else {
      mutations.push(...diffMutations(left[key], right[key], path));
    }
  }
  return mutations.sort((a, b) => a.path.localeCompare(b.path));
}
```

- [ ] **Step 4: Write the committed fixture**

Create `src/providers/jobs/fixtures/gke-autopilot-dry-run.json`:

```json
{
  "capturedAt": "2026-09-22",
  "platform": "gke-autopilot",
  "provisional": true,
  "source": "PROVISIONAL — written from Google's autopilot-resource-requests, sandbox-pods and autopilot-security documentation (checked 2026-09-22), not from a cluster. Task 9 of docs/superpowers/plans/2026-09-22-phase-12-gke-autopilot.md replaces this file with a real server-side dry-run capture via `npm run capture:autopilot`, which sets provisional to false.",
  "notes": [
    "No resource mutations are listed, and that is the claim this fixture exists to test: the builder already emits Autopilot-legal CPU, memory and ephemeral-storage, with limits equal to requests, so the admission controller has nothing left to rewrite.",
    "The two node-health tolerations the API server defaults on every pod are normalized by kubernetes-isolation.ts itself, not by the platform profile, so they are listed here only because they arrive in the same array."
  ],
  "mutations": [
    {
      "op": "add",
      "path": "/metadata/annotations/autopilot.gke.io~1resource-adjustment",
      "value": "{\"input\":{\"containers\":[]},\"output\":{\"containers\":[]},\"modified\":false}"
    },
    {
      "op": "add",
      "path": "/metadata/annotations/autopilot.gke.io~1warden-version",
      "value": "provisional"
    },
    {
      "op": "add",
      "path": "/spec/nodeSelector",
      "value": { "sandbox.gke.io/runtime": "gvisor" }
    },
    {
      "op": "add",
      "path": "/spec/tolerations",
      "value": [
        { "key": "sandbox.gke.io/runtime", "operator": "Equal", "value": "gvisor", "effect": "NoSchedule" },
        {
          "key": "node.kubernetes.io/not-ready",
          "operator": "Exists",
          "effect": "NoExecute",
          "tolerationSeconds": 300
        },
        {
          "key": "node.kubernetes.io/unreachable",
          "operator": "Exists",
          "effect": "NoExecute",
          "tolerationSeconds": 300
        }
      ]
    }
  ]
}
```

- [ ] **Step 5: Run the fixture-machinery test**

Run: `npx vitest run src/providers/jobs/kubernetes-dry-run-fixture.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Write the failing attestation test**

Create `src/providers/jobs/kubernetes-autopilot-attestation.test.ts`:

```ts
/**
 * Attestation against the recorded Autopilot mutation set. The submitted pod is
 * rebuilt from the live builder, the fixture supplies only what the platform
 * changes, and the comparator must accept exactly that and nothing more.
 */
import { describe, expect, it } from "vitest";
import type { V1Pod } from "@kubernetes/client-node";
import { KUBERNETES_ISOLATION_ERROR, assertRunPodMatches, buildRunPod } from "./kubernetes-isolation.js";
import { applyMutations, loadDryRunFixture } from "./kubernetes-dry-run-fixture.js";
import type { JobSpec } from "./types.js";

const IMAGE = `us-central1-docker.pkg.dev/example/wardby/coding-worker@sha256:${"a".repeat(64)}`;
const spec: JobSpec = {
  kind: "coding-agent",
  runId: "run-autopilot-1",
  provider: "codex",
  image: IMAGE,
  inputArtifact: "/tmp/input.json",
  timeoutSec: 900,
  limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
  labels: {},
};
const options = {
  namespace: "wardby-coding",
  proxyIp: "10.96.0.50",
  runtimeClassName: "gvisor",
  platform: "gke-autopilot" as const,
};
const fixture = loadDryRunFixture();
const submitted = () => buildRunPod(spec, options);
const returned = () => applyMutations(submitted(), fixture.mutations);

describe("Autopilot attestation", () => {
  // Named, not silent: while the fixture is provisional this test is reported as skipped with
  // that sentence in its title on every `npm test`, and it becomes a real assertion the moment
  // `npm run capture:autopilot` replaces the file.
  it.skipIf(fixture.provisional)(
    fixture.provisional
      ? "PENDING: the committed fixture is PROVISIONAL (documentation-derived), not a server-side dry-run capture"
      : "the committed fixture is a real server-side dry-run capture",
    () => {
      expect(fixture.provisional).toBe(false);
      expect(fixture.source).not.toContain("PROVISIONAL");
    },
  );

  it("accepts the recorded mutation set under gke-autopilot", () => {
    expect(() => assertRunPodMatches(returned(), submitted(), "gke-autopilot")).not.toThrow();
  });

  it("rejects the same mutation set under generic, and by default", () => {
    expect(() => assertRunPodMatches(returned(), submitted(), "generic")).toThrow(KUBERNETES_ISOLATION_ERROR);
    expect(() => assertRunPodMatches(returned(), submitted())).toThrow(KUBERNETES_ISOLATION_ERROR);
  });

  it("rejects one more mutation the profile does not name", () => {
    for (const tamper of [
      (p: V1Pod) => void (p.metadata!.annotations!["example.com/injected"] = "1"),
      (p: V1Pod) => void (p.metadata!.labels!["example.com/injected"] = "1"),
      (p: V1Pod) => void (p.spec!.nodeSelector!["sandbox.gke.io/runtime"] = "none"),
      (p: V1Pod) => void p.spec!.tolerations!.push({ key: "anything", operator: "Exists" }),
      (p: V1Pod) => void (p.spec!.hostPID = true),
      (p: V1Pod) => void (p.spec!.serviceAccountName = "default"),
      (p: V1Pod) => void (p.spec!.securityContext!.runAsUser = 0),
      (p: V1Pod) => void delete p.spec!.securityContext!.seccompProfile,
      (p: V1Pod) => void delete p.spec!.runtimeClassName,
    ]) {
      const tampered = returned();
      tamper(tampered);
      expect(() => assertRunPodMatches(tampered, submitted(), "gke-autopilot")).toThrow(KUBERNETES_ISOLATION_ERROR);
    }
  });

  it("rejects a resource rewrite, which is what conformance exists to prevent", () => {
    const tampered = returned();
    tampered.spec!.containers.find((c) => c.name === "worker")!.resources!.requests!.cpu = "1250m";
    expect(() => assertRunPodMatches(tampered, submitted(), "gke-autopilot")).toThrow(KUBERNETES_ISOLATION_ERROR);
  });
});
```

- [ ] **Step 7: Run it**

Run: `npx vitest run src/providers/jobs/kubernetes-autopilot-attestation.test.ts`
Expected: PASS, with one test reported as skipped and titled `PENDING: the committed fixture is PROVISIONAL…`. If "accepts the recorded mutation set" fails, the profile's allowance list and the fixture disagree — fix the _profile_, not the test.

- [ ] **Step 8: Add the dry-run seam method**

In `src/providers/jobs/kubernetes-api.ts`, after `createPod`:

```ts
  /**
   * Server-side dry-run create: the API server runs the whole admission chain and returns the
   * mutated object without persisting anything. Used only by src/tools/capture-autopilot-dry-run.ts;
   * never by the launcher, which must not let a cluster tell it what it is allowed to change.
   */
  dryRunCreatePod(namespace: string, body: V1Pod): Promise<V1Pod>;
```

In `src/providers/jobs/kubernetes-client.ts`, after `createPod`:

```ts
  dryRunCreatePod(namespace: string, body: V1Pod): Promise<V1Pod> {
    return create(`pod/${namespace}/${body.metadata?.name}?dryRun`, () =>
      this.core.createNamespacedPod({ namespace, body, dryRun: "All" }),
    );
  }
```

In `src/providers/jobs/fake-kubernetes-api.ts`, after `createPod`:

```ts
  /** Echoes the submitted pod without storing it: a dry run persists nothing. */
  async dryRunCreatePod(_namespace: string, body: V1Pod) {
    return structuredClone(body);
  }
```

Add to `src/providers/jobs/fake-kubernetes-api.test.ts`:

```ts
it("stores nothing on a dry-run create", async () => {
  const api = new FakeKubernetesApi();
  const pod = { metadata: { name: "wardby-run-x" }, spec: { containers: [] } };
  expect(await api.dryRunCreatePod("wardby-coding", pod)).toEqual(pod);
  expect(await api.readPod("wardby-coding", "wardby-run-x")).toBeUndefined();
});
```

- [ ] **Step 9: Write the capture tool**

Create `src/tools/capture-autopilot-dry-run.ts`:

```ts
/**
 * Captures a platform's admission mutations into the committed fixture.
 *
 * Submits the pod the launcher would really build with `dryRun=All`: the API
 * server runs its whole admission chain and returns the mutated object without
 * scheduling or persisting anything, so the exact mutation set can be read from
 * a real cluster for the price of one API call and no billable workload.
 *
 * This is a development tool, run deliberately and reviewed in a diff. Nothing
 * at runtime calls it: the admission chain that produces these mutations is the
 * same one an attacker with cluster access would subvert, so it can never be
 * allowed to bless itself at launch time.
 *
 *   npm run capture:autopilot     # writes the fixture and prints the mutation list
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "../env.js";
import { loadContainerExecutorConfig, loadKubernetesJobConfig } from "../config/providers.js";
import { ClientNodeKubernetesApi } from "../providers/jobs/kubernetes-client.js";
import { buildRunPod } from "../providers/jobs/kubernetes-isolation.js";
import { readProxyWitness } from "../providers/jobs/kubernetes-witness.js";
import { diffMutations, type DryRunFixture } from "../providers/jobs/kubernetes-dry-run-fixture.js";
import type { JobSpec } from "../providers/jobs/types.js";

const FIXTURE = fileURLToPath(new URL("../providers/jobs/fixtures/gke-autopilot-dry-run.json", import.meta.url));

async function main(): Promise<void> {
  const config = loadKubernetesJobConfig();
  const container = loadContainerExecutorConfig();
  if (config.platform === "generic") {
    throw new Error("Set KUBERNETES_PLATFORM to the platform you are capturing (e.g. gke-autopilot).");
  }
  if (!container.workerImage) throw new Error("CODING_WORKER_IMAGE is required.");
  const api = new ClientNodeKubernetesApi({ context: config.context });
  const witness = await readProxyWitness(api, config.namespace, config.proxyService);
  const spec: JobSpec = {
    kind: "coding-agent",
    runId: "capture-dry-run",
    provider: "codex",
    image: container.workerImage,
    inputArtifact: "",
    timeoutSec: 900,
    limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
    labels: {},
  };
  const submitted = buildRunPod(spec, {
    namespace: config.namespace,
    proxyIp: witness.clusterIp,
    runtimeClassName: config.runtimeClassName,
    platform: config.platform,
  });
  const returned = await api.dryRunCreatePod(config.namespace, submitted);
  // Fields every API server fills in on any create; they are not platform mutations.
  for (const key of ["creationTimestamp", "uid", "resourceVersion", "generation", "managedFields", "selfLink"]) {
    delete (returned.metadata as Record<string, unknown> | undefined)?.[key];
  }
  delete returned.status;
  const mutations = diffMutations(submitted, returned);
  const fixture: DryRunFixture = {
    capturedAt: new Date().toISOString().slice(0, 10),
    platform: config.platform,
    provisional: false,
    source: `server-side dry run against a ${config.platform} cluster; the cluster version is recorded in docs/phase-12-kubernetes-evidence.md`,
    notes: [
      "Captured by src/tools/capture-autopilot-dry-run.ts. Every entry must have a matching allowance in kubernetes-platform.ts, or the attestation test fails.",
    ],
    mutations,
  };
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(JSON.stringify(mutations, null, 2));
  console.log(`wrote ${FIXTURE} (${mutations.length} mutation(s))`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

Add to `package.json` scripts, after `"cli"`:

```json
    "capture:autopilot": "tsx src/tools/capture-autopilot-dry-run.ts",
```

- [ ] **Step 10: Full verification and commit**

```bash
npm run typecheck && npm run lint && npm test && npm run format:check
git add src/providers/jobs/kubernetes-api.ts src/providers/jobs/kubernetes-client.ts \
  src/providers/jobs/fake-kubernetes-api.ts src/providers/jobs/fake-kubernetes-api.test.ts \
  src/providers/jobs/kubernetes-dry-run-fixture.ts src/providers/jobs/kubernetes-dry-run-fixture.test.ts \
  src/providers/jobs/fixtures/gke-autopilot-dry-run.json \
  src/providers/jobs/kubernetes-autopilot-attestation.test.ts \
  src/tools/capture-autopilot-dry-run.ts package.json
git commit -m "$(cat <<'EOF'
feat(kubernetes): capture platform admission mutations into a reviewed fixture

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 8: Reprove it all on `kind`

**Files:**

- Modify: `src/providers/jobs/kubernetes.integration.test.ts`
- Modify: `deploy/kind-coding/README.md`
- Modify: `docs/phase-12-kubernetes-evidence.md`

**Interfaces:**

- Consumes: everything from Tasks 1–7.
- Produces: a green `npm run test:kubernetes` against the `kind` harness with the new witness.

**Security note:** this is the only test that proves the _real_ CNI blocks the deny port while allowing 8787 on the same pod. If it cannot be made to pass, the witness is wrong — do not weaken the assertion.

- [ ] **Step 1: Update the integration test**

In `src/providers/jobs/kubernetes.integration.test.ts`:

(a) `beforeAll` — replace the cluster-DNS reads with the proxy's, and drop `dnsPodIp`:

```ts
const result = await runKubernetesPreflight({ api: rawApi, config, workerImage, maxDiskMb: 2048 });
cluster = { proxyIp: result.proxyIp };

const apiServerService = await rawApi.readService("default", "kubernetes");
const apiServerClusterIp = apiServerService?.spec?.clusterIP;
if (!apiServerClusterIp) throw new Error("Service default/kubernetes has no ClusterIP");
apiServerIp = apiServerClusterIp;

const proxyEndpoints = await rawCore.readNamespacedEndpoints({ name: config.proxyService, namespace });
const proxyIp = readyEndpointIp(proxyEndpoints);
if (!proxyIp) throw new Error(`${namespace}/${config.proxyService} has no ready endpoint`);
proxyPodIp = proxyIp;
```

Remove the `dnsPodIp` declaration and the `kube-dns` endpoints read above it.

(b) The probe matcher:

```ts
/** The enforcement gate's probe is a distinctive `node -e` script measuring both proxy ports. */
function isEnforcementProbe(command: string[]): boolean {
  return (
    command[0] === "node" &&
    command[1] === "-e" &&
    typeof command[2] === "string" &&
    command[2].includes("await tcp(8788)")
  );
}
```

(c) The in-pod isolation probe — replace the `clusterDnsIp`/`dnsPodIp` lines with the deny-port lines:

```ts
          `apiServerIp:await tcp(${JSON.stringify(apiServerIp)},443),`,
          `proxyPodIp:await tcp(${JSON.stringify(proxyPodIp)},8787),`,
          `proxyPodDeny:await tcp(${JSON.stringify(proxyPodIp)},8788),`,
          `proxyDeny:await tcp(${JSON.stringify(cluster.proxyIp)},8788),`,
          'proxy:await tcp("wardby-proxy",8787)}))})()',
```

```ts
expect(JSON.parse(probe.out.trim())).toEqual({
  uid: 10001,
  rootWritable: false,
  token: false,
  dns: false,
  internet: false,
  metadata: false,
  apiServerIp: false,
  // The whole witness, proven at the pod-IP level as well as through the Service: the same
  // destination pod is reachable on 8787 and not on 8788, which only a programmed,
  // port-scoped NetworkPolicy can produce.
  proxyPodIp: true,
  proxyPodDeny: false,
  proxyDeny: false,
  proxy: true,
});
```

(d) Update the file's header comment: the pod cannot reach the API server ClusterIP or the proxy's deny port (by Service IP and by pod IP) while it can reach the proxy on 8787.

- [ ] **Step 2: Bring up the harness and run the suite**

> Requires Docker and `kind`. This is local only; it creates no cloud resources.

```bash
bash deploy/kind-coding/up.sh
npm run cli -- coding preflight
npm run test:kubernetes
```

Expected: the preflight prints `coding preflight passed (platform, namespace, proxy-service, worker-image, canary) for <digest>`, and all three integration tests pass. If the `proxyPodDeny` assertion fails with `true`, the proxy NetworkPolicy from Task 1 is missing its 8788 ingress rule or the run policy is wrong — fix the manifest, not the test.

- [ ] **Step 3: Update the harness README**

In `deploy/kind-coding/README.md`, replace any list of the preflight's checks with the five current ones, and add:

```markdown
The proxy exposes a second port, **8788 — the deny port**. Nothing is served
there: it exists so that a coding-run pod which can reach the proxy on 8787 but
not on 8788 has proven its own NetworkPolicy is programmed _and_ port-scoped.
The proxy's policy deliberately allows ingress on 8788 from coding-run pods, so
the run pod's own egress policy is the only thing that can block it. This tree's
`manifests/` are cluster-agnostic; `manifests/overlays/` now holds more than the
`kind` target (see `overlays/gke-autopilot/`), and renaming the directory is a
follow-up.
```

- [ ] **Step 4: Update the evidence document's gaps**

In `docs/phase-12-kubernetes-evidence.md`, under "Known gaps":

- delete the two bullets this work closes ("The enforcement witness is the cluster's DNS service…" and "Autopilot's admission mutations will fail deny-by-default attestation…");
- replace the preflight section's check list with the five current checks and the new witness;
- keep the record-ConfigMap garbage-collection bullet and add to it: "this also applies to any managed cluster the launcher is pointed at, including the Autopilot proof below";
- add one line about the gate: "Plan 2b's remaining items are not a gate on this work: nothing below depends on them, and the launcher's out-of-namespace dependency (kube-system) is removed here rather than deferred."

- [ ] **Step 5: Tear the harness down and commit**

```bash
bash deploy/kind-coding/down.sh
npm run typecheck && npm run lint && npm test && npm run format:check
git add src/providers/jobs/kubernetes.integration.test.ts deploy/kind-coding/README.md docs/phase-12-kubernetes-evidence.md
git commit -m "$(cat <<'EOF'
test(kubernetes): prove the two-port deny witness on the kind harness

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

### Task 9: The live GKE Autopilot run

> ## ⚠️ THIS TASK CREATES BILLABLE CLOUD RESOURCES
>
> A GKE Autopilot cluster bills a control-plane fee for as long as it exists,
> plus the pods it runs, plus Artifact Registry storage and egress.
>
> **Stop and get the user's explicit approval before running any `gcloud`,
> `terraform`, or `kubectl` command in this task.** Ask for it in one message
> that names the cluster, the region, and the expected cost, and wait for a
> "yes". Approval for one step is not approval for the rest: if the plan
> changes mid-task (a second cluster, a bigger machine class, a longer-lived
> resource), ask again. Steps 12 and 13 (teardown) run the same day, whether or
> not the run succeeded.
>
> **Never commit anything produced to validate this deployment** — no
> `*.tfvars`, no `.terraform/`, no state, no captured resource ids, no project
> id, no cluster name, and no real registry path. The evidence document records
> outcomes and versions, never identities (use `<project>`, `<region>`).

**Files:**

- Create: `deploy/kind-coding/manifests/overlays/gke-autopilot/kustomization.yaml`
- Create: `deploy/kind-coding/manifests/overlays/gke-autopilot/proxy-dns-egress.yaml`
- Create: `deploy/kind-coding/manifests/overlays/gke-autopilot/throwaway-database.yaml`
- Create: `deploy/kind-coding/manifests/overlays/gke-autopilot/proxy-database-egress.yaml`
- Modify: `src/providers/jobs/fixtures/gke-autopilot-dry-run.json` (replaced by the real capture)
- Modify: `src/providers/jobs/kubernetes-platform.ts` (only if the capture shows something the profile does not name)
- Modify: `docs/phase-12-kubernetes-evidence.md`

**Interfaces:**

- Consumes: everything from Tasks 1–8; `npm run capture:autopilot` (Task 7); `KUBERNETES_PREFLIGHT_TIMEOUT_MS` / `KUBERNETES_READY_TIMEOUT_MS` (Task 4).
- Produces: a replaced fixture sourced from a real cluster (`provisional: false`), and a recorded live run.

- [ ] **Step 1: Write the Autopilot overlay (no cloud access needed)**

Create `deploy/kind-coding/manifests/overlays/gke-autopilot/kustomization.yaml`:

```yaml
# GKE Autopilot target for the cluster-agnostic manifests in ../../base.
# No project, cluster, region, or registry path appears here: the runtime image
# digest is substituted at apply time exactly as up.sh does for kind.
resources:
  - ../../base
  - proxy-dns-egress.yaml
  - throwaway-database.yaml
  - proxy-database-egress.yaml
```

Create `deploy/kind-coding/manifests/overlays/gke-autopilot/proxy-dns-egress.yaml`:

```yaml
# Autopilot has no kube-dns: Cloud DNS is the only provider since
# 1.25.9-gke.400, and a pod resolves through the node-local metadata endpoint
# at 169.254.169.254:53. The base policy excepts 169.254.0.0/16 from its
# internet rule and otherwise only permits kube-dns pods, so without this rule
# the proxy cannot resolve any model provider's hostname and every coding run
# fails at the first API call. NetworkPolicies are additive, so this opens
# exactly port 53 to exactly that address and widens nothing else.
#
# Coding-run pods are unaffected: their own policy permits exactly one
# destination (the proxy on 8787) and their dnsPolicy is None.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: wardby-coding-proxy-dns
  namespace: wardby-coding
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: wardby-coding-proxy
  policyTypes:
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 169.254.169.254/32
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

Create `deploy/kind-coding/manifests/overlays/gke-autopilot/throwaway-database.yaml`:

```yaml
# A THROWAWAY database for the Autopilot proof run, and nothing else.
#
# NOT FOR PRODUCTION. Storage is an emptyDir, so every restart loses all data;
# there is no backup, no replication, no resource headroom and no upgrade path.
# It exists because the in-cluster proxy needs a DATABASE_URL it can reach and
# the control plane must share it, and because a managed database would be a
# second billable resource with its own teardown for a smoke run that needs no
# durability. It is destroyed with the cluster.
#
# The password is supplied at apply time from the wardby-coding-proxy-env
# Secret's own DATABASE_URL; nothing here contains a credential.
apiVersion: v1
kind: Service
metadata:
  name: wardby-throwaway-db
  namespace: wardby-coding
  labels:
    app.kubernetes.io/name: wardby-throwaway-db
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: wardby-throwaway-db
  ports:
    - name: postgres
      port: 5432
      targetPort: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: wardby-throwaway-db
  namespace: wardby-coding
  labels:
    app.kubernetes.io/name: wardby-throwaway-db
spec:
  serviceName: wardby-throwaway-db
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: wardby-throwaway-db
  template:
    metadata:
      labels:
        app.kubernetes.io/name: wardby-throwaway-db
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 999
        fsGroup: 999
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: postgres
          image: postgres:17-alpine
          envFrom:
            - secretRef:
                name: wardby-throwaway-db-env
          env:
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          ports:
            - name: postgres
              containerPort: 5432
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          resources:
            requests:
              cpu: 500m
              memory: 2Gi
              ephemeral-storage: 4Gi
            limits:
              cpu: 500m
              memory: 2Gi
              ephemeral-storage: 4Gi
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
            - name: run
              mountPath: /var/run/postgresql
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "wardby"]
            periodSeconds: 5
      volumes:
        - name: data
          emptyDir:
            sizeLimit: 4Gi
        - name: run
          emptyDir:
            medium: Memory
            sizeLimit: 16Mi
---
# The proxy reaches the throwaway database; nothing else in the namespace may,
# and the database itself gets no egress at all.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: wardby-throwaway-db
  namespace: wardby-coding
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: wardby-throwaway-db
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: wardby-coding-proxy
      ports:
        - protocol: TCP
          port: 5432
```

Create `deploy/kind-coding/manifests/overlays/gke-autopilot/proxy-database-egress.yaml`:

```yaml
# The proxy's database reachability on this target: the in-cluster throwaway
# database only. No instance, project, or region identity belongs in this
# tracked file; a real deployment replaces this rule with one naming its own
# managed database's address.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: wardby-coding-proxy-database
  namespace: wardby-coding
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: wardby-coding-proxy
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: wardby-throwaway-db
      ports:
        - protocol: TCP
          port: 5432
```

Verify offline: `kubectl kustomize deploy/kind-coding/manifests/overlays/gke-autopilot | grep -c "kind: NetworkPolicy"` → expect `5` (default-deny, proxy, proxy-dns, throwaway-db, proxy-database).

- [ ] **Step 2: Ask for approval**

Send the user one message, and wait:

> Task 9 needs a live GKE Autopilot cluster. It creates billable resources: one
> Autopilot cluster (a control-plane fee for as long as it exists, plus the pods it
> runs — the proxy, a throwaway in-cluster Postgres, and one coding run) and one
> Artifact Registry repository, plus egress. There is deliberately **no Cloud SQL**:
> the database is a single ephemeral pod destroyed with the cluster. I will create
> the cluster in `<region>` of project `<project>`, run one coding run, capture the
> admission mutations, and delete everything the same day. May I proceed? I need the
> project id, the region, and the name to use for the cluster.

Do not run anything below without a clear "yes".

- [ ] **Step 3: Create the cluster (approval required)**

```bash
# $PROJECT, $REGION, $CLUSTER come from the user's answer; none of them goes into a tracked file.
gcloud container clusters create-auto "$CLUSTER" --project "$PROJECT" --region "$REGION"
gcloud container clusters get-credentials "$CLUSTER" --project "$PROJECT" --region "$REGION"
kubectl config current-context   # record the context name for KUBERNETES_CONTEXT
kubectl version -o json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).serverVersion.gitVersion))'
```

Record the server version for the evidence document.

- [ ] **Step 4: Push the images**

```bash
gcloud artifacts repositories create wardby --repository-format=docker --location "$REGION" --project "$PROJECT"
gcloud auth configure-docker "${REGION}-docker.pkg.dev"
REPO="${REGION}-docker.pkg.dev/${PROJECT}/wardby"
docker build -f src/coding-worker/Dockerfile -t "${REPO}/coding-worker:live" .
docker build -f deploy/Dockerfile --target runtime -t "${REPO}/runtime:live" .
docker push "${REPO}/coding-worker:live"
docker push "${REPO}/runtime:live"
WORKER_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "${REPO}/coding-worker:live")"
RUNTIME_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "${REPO}/runtime:live")"
```

- [ ] **Step 5: Apply the namespace, the two Secrets, and the manifests**

Assemble both Secrets the way `deploy/kind-coding/up.sh` does — with bash builtins and a pipe into `kubectl apply -f -`, never as a command-line argument, since an argv is readable by anything that can list processes. The throwaway database's password is generated here and used in both Secrets:

```bash
kubectl apply -f deploy/kind-coding/manifests/base/namespace.yaml
DB_PASSWORD="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')"
DB_URL="postgresql://wardby:${DB_PASSWORD}@wardby-throwaway-db.wardby-coding.svc.cluster.local:5432/wardby"
# wardby-throwaway-db-env: POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
# wardby-coding-proxy-env: DATABASE_URL / OPENAI_API_KEY / ANTHROPIC_API_KEY
kubectl kustomize deploy/kind-coding/manifests/overlays/gke-autopilot \
  | sed "s|image: wardby-runtime|image: ${RUNTIME_DIGEST}|" \
  | kubectl apply -f -
kubectl -n wardby-coding rollout status statefulset/wardby-throwaway-db --timeout=600s
kubectl -n wardby-coding rollout status deploy/wardby-coding-proxy --timeout=600s
```

Then point the **local control plane** at the same database by port-forwarding it, so migrations and the run's own records share it:

```bash
kubectl -n wardby-coding port-forward svc/wardby-throwaway-db 55433:5432 &
DATABASE_URL="postgresql://wardby:${DB_PASSWORD}@localhost:55433/wardby" npm run prisma:migrate
```

Keep the port-forward running for the rest of the task, and export the same `DATABASE_URL` in the shell that triggers the run. Nothing here is written to a tracked file.

- [ ] **Step 6: Verify DNS from inside the proxy pod before trusting anything else**

```bash
kubectl -n wardby-coding exec deploy/wardby-coding-proxy -- \
  node -e 'require("node:dns").promises.lookup("api.openai.com").then(r=>console.log("resolved",r.address),e=>{console.error("DNS FAILED",e.code);process.exit(1)})'
```

Expected: `resolved <address>`. A failure here means the Autopilot DNS egress rule does not match this cluster's resolver path — fix `proxy-dns-egress.yaml` now. Without this check the same fault surfaces much later as an opaque model-call error inside a coding run.

- [ ] **Step 7: Run the preflight with timeouts a cold cluster can meet**

Set, in the shell only (not in a tracked file):

```bash
export JOB_LAUNCHER=kubernetes
export KUBERNETES_PLATFORM=gke-autopilot
export KUBERNETES_RUNTIME_CLASS=gvisor
export KUBERNETES_CONTEXT="<the context from step 3>"
export CODING_WORKER_IMAGE="$WORKER_DIGEST"
# A cold Autopilot cluster provisions a node, pulls the image and starts a gVisor
# sandbox; the 90 s / 120 s defaults are for a warm local cluster.
export KUBERNETES_PREFLIGHT_TIMEOUT_MS=600000
export KUBERNETES_READY_TIMEOUT_MS=600000
npm run cli -- coding preflight
```

Expected: `coding preflight passed (platform, namespace, proxy-service, worker-image, canary) for <digest>`.

If it fails on `canary` with `proxyDeny: true`, Dataplane V2 has not programmed the policy within the canary's 20 s settle window — re-run once before investigating. If it fails on `platform`, the message names the setting to fix. If it fails on `:timeout`, raise the two values above rather than editing code.

- [ ] **Step 8: Capture the real mutation set**

```bash
npm run capture:autopilot
git diff src/providers/jobs/fixtures/gke-autopilot-dry-run.json
npm test -- src/providers/jobs/kubernetes-autopilot-attestation.test.ts
```

The previously-skipped `PENDING: the committed fixture is PROVISIONAL…` test must now run and pass; if it is still reported as skipped, the capture did not write the file.

Read the diff line by line. For every mutation the real capture shows that the provisional fixture did not:

- if it is metadata Autopilot adds, add the exact key prefix to `GKE_AUTOPILOT.metadata` in `src/providers/jobs/kubernetes-platform.ts`, with a comment naming what adds it;
- if it is a **resource rewrite**, the builder's conformance is wrong — fix `conformResources`, do not widen the allowance;
- if `/spec/securityContext/seccompProfile` was removed, flip `dropsPodSeccompProfile` to `true` and note it in the evidence document (this is the open question the profile records);
- if it is anything else (another security field, a volume, a container change), stop and report it. That is a finding, not a formality.

For every mutation the provisional fixture listed that the real capture does not show, delete the now-unneeded allowance from the profile — an allowance nothing needs is attack surface.

Re-run `npm test` until green.

- [ ] **Step 9: One real coding run**

Trigger one coding agent against the fixture repository `chfields/knock-knock-jokes` (the same one the `kind` evidence used), with a small, verifiable task. Record: run id, model, toolchain, task, outcome, duration, cost, and the PR number.

- [ ] **Step 10: Confirm gVisor actually ran the pod**

```bash
kubectl -n wardby-coding get pod -l wardby.io/component=coding-run \
  -o jsonpath='{.items[0].spec.runtimeClassName}{"\n"}{.items[0].spec.nodeSelector}{"\n"}'
```

Expected: `gvisor`. Record the output (with no node names) in the evidence document.

- [ ] **Step 11: Record the evidence**

In `docs/phase-12-kubernetes-evidence.md`, add a section:

```markdown
## GKE Autopilot with gVisor

Date: <YYYY-MM-DD>. Branch `phase-12-gke-autopilot`. A GKE Autopilot cluster in
`<region>` of `<project>` (both redacted deliberately — see CLAUDE.md
"Deployment (deploy/) — STRICT"), Kubernetes server `<version>`, namespace
`wardby-coding`, images from Artifact Registry, `runtimeClassName: gvisor`.

- **Preflight:** `coding preflight passed (platform, namespace, proxy-service, worker-image, canary)`,
  with `KUBERNETES_PREFLIGHT_TIMEOUT_MS` and `KUBERNETES_READY_TIMEOUT_MS` raised
  to 600 000 — a cold Autopilot cluster provisioning a node and starting a gVisor
  sandbox does not fit the 90 s / 120 s defaults.
- **Witness:** the proxy's deny port, not kube-dns — Autopilot has none. The gate
  measured 8787 and 8788 in one probe and released the worker only after three
  consecutive `(reachable, blocked)` observations.
- **Attestation:** the pod read back from the API server matched the pod wardby
  built, under the `gke-autopilot` profile and nothing wider. The mutation set
  the API server applied is committed at
  `src/providers/jobs/fixtures/gke-autopilot-dry-run.json`, captured with
  `npm run capture:autopilot`; `npm test` exercises it without a cluster.
- **Resources:** no admission rewrite. <state what conformance produced, e.g.
  "a 0.5 vCPU / 512 MiB request was emitted as 500m / 512Mi and came back
  unchanged">. The proxy Deployment's own 250m / 256Mi is already exactly
  Autopilot's 1 GiB-per-vCPU floor, so it was not rewritten either.
- **seccomp under gVisor:** <state what the capture showed for
  `spec.securityContext.seccompProfile`>.
- **Database:** a throwaway single-pod Postgres inside the cluster
  (`deploy/kind-coding/manifests/overlays/gke-autopilot/throwaway-database.yaml`),
  emptyDir-backed, shared with the local control plane through a port-forward,
  destroyed with the cluster. No managed database was created.
- **Live run:** <run id>, <model>, <toolchain>, <task>, <outcome>, <duration>,
  <cost>, PR #<n>.
- **Cluster deleted** the same day; see the teardown below.

### What this did not prove

- Workspaces larger than 9216 MiB. Autopilot caps a pod at 10 GiB of ephemeral
  storage and wardby refuses anything over that at startup, naming the cap.
  Performance-class storage and per-run PersistentVolumes stay deferred.
- Anything about durability: the database was ephemeral by design.
- Anything about a second Autopilot version or compute class: the captured
  mutation set is from this one cluster. A different version that adds something
  new fails closed, as a rejected run, and re-capturing is one command.
- Garbage collection of per-run record ConfigMaps, which this cluster also
  lacked; it was deleted before that mattered.
```

- [ ] **Step 12: Tear everything down (same day)**

```bash
kill %1 2>/dev/null || true   # the port-forward from step 5
gcloud container clusters delete "$CLUSTER" --project "$PROJECT" --region "$REGION" --quiet
gcloud artifacts repositories delete wardby --location "$REGION" --project "$PROJECT" --quiet
```

Deleting the cluster destroys the throwaway database with it; there is nothing else to clean up.

- [ ] **Step 13: Confirm nothing billable is left, without printing secrets**

```bash
gcloud container clusters list --project "$PROJECT"
gcloud artifacts repositories list --project "$PROJECT"
```

Expected: neither lists the resources from step 3 or 4. Do **not** use `ps aux` or any command that prints another process's argv — a live command's full argv (API keys included) is readable there; check resource state instead.

- [ ] **Step 14: Confirm the working tree has no deployment artifacts, then commit**

```bash
git status --porcelain
```

Expected: only `deploy/kind-coding/manifests/overlays/gke-autopilot/*`, the fixture, `kubernetes-platform.ts` (if the capture required a change), and the evidence document. No `*.tfvars`, no `.terraform/`, no kubeconfig, no file containing the project id or the database password.

```bash
npm run typecheck && npm run lint && npm test && npm run format:check
git add deploy/kind-coding/manifests/overlays/gke-autopilot src/providers/jobs/fixtures/gke-autopilot-dry-run.json \
  src/providers/jobs/kubernetes-platform.ts docs/phase-12-kubernetes-evidence.md
git commit -m "$(cat <<'EOF'
feat(kubernetes): prove a live coding run on GKE Autopilot with gVisor

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

## Self-review

**Spec coverage.**

| Spec section                                                               | Task(s)                                                                                                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Decision 1 — witness becomes the proxy deny port                           | 1, 3                                                                                                                                |
| …the decision table (connects/blocked, connects/connects, blocked/blocked) | 3 — the probe measures both ports and returns one of exactly three codes                                                            |
| …the vacuity guard                                                         | 3 (the two-port probe itself), 2 (the configuration cross-check)                                                                    |
| …`cluster-dns` check and the kube-system Role deleted                      | 3                                                                                                                                   |
| …both users change together (canary + gate)                                | 3                                                                                                                                   |
| Decision 2 — conform first (CPU, memory, ephemeral, explicit values)       | 4, 5                                                                                                                                |
| …named error where a request cannot conform                                | 4, 5                                                                                                                                |
| …write the remainder down (profile + normalizer)                           | 4, 5                                                                                                                                |
| …the dry run is a development tool, never runtime                          | 7                                                                                                                                   |
| Design — platform profiles, `KUBERNETES_PLATFORM`                          | 4                                                                                                                                   |
| Design — gVisor mandatory on the profile                                   | 4, 6                                                                                                                                |
| Design — startup validation (3 refusals)                                   | 6 (runtime class, `CODING_MAX_DISK_MB`), 2+3 (proxy Service exposes the deny port with a ready endpoint)                            |
| Design — what does not change                                              | Global Constraints; no task touches pod layout, gate marker, capability Secret, record ConfigMap, extraction, queue, or concurrency |
| Testing — per-profile resource unit tests                                  | 4                                                                                                                                   |
| Testing — attestation against a recorded fixture                           | 7                                                                                                                                   |
| Testing — rejection tests; `generic` tolerates nothing new                 | 4, 5, 7                                                                                                                             |
| Testing — `kind` suite still passes, new witness                           | 8                                                                                                                                   |
| Testing — one live Autopilot run with gVisor                               | 9                                                                                                                                   |
| Risks — deny port serves nothing                                           | 1                                                                                                                                   |
| Risks — mutation set may differ by version                                 | 7 (re-capture is one command), 9 (recorded as a non-proof)                                                                          |
| Risks — performance-class storage deferred                                 | 9 (evidence "What this did not prove")                                                                                              |
| Risks — cost, nothing billable without approval                            | 9                                                                                                                                   |

**Deviations from the spec, deliberately made here:**

1. **`CODING_MAX_DISK_MB` refusal threshold.** The spec says "refuse when `CODING_MAX_DISK_MB` exceeds the 10 GiB ceiling". This plan refuses when `maxDiskMb + 1024` exceeds it (i.e. above 9216 MiB), because the worker container's 1 GiB ephemeral reservation counts toward the same pod total. Refusing at exactly 10240 would let a deployment start and then fail every launch at build time. The message names both the cap and the reservation. Worth amending the spec's sentence in a follow-up so the two do not read as contradicting.
2. **The gate measures both ports, not just the deny port.** The spec's prose describes the gate as probing the deny port, while its own decision table has three rows keyed on both. The table is right: a NetworkPolicy denial drops rather than rejects, so a one-port probe cannot distinguish an enforced policy from a dead proxy on the dataplane Autopilot actually runs. The gate therefore requires `(8787 connected, 8788 blocked)` in the same exec, and reports `kubernetes_policy_witness_unavailable` when 8787 itself was unreachable at the bound.
3. **Two new environment knobs.** `KUBERNETES_PREFLIGHT_TIMEOUT_MS` and `KUBERNETES_READY_TIMEOUT_MS` are not in the spec. They are required for the spec's own acceptance criterion: a cold Autopilot cluster provisioning a node and starting a gVisor sandbox exceeds the hard-coded 90 s / 120 s, and without a lever the live run reports a timeout no code change can avoid.
4. **The provisional fixture.** CI must run without a cluster, and the real mutation set only exists once a cluster does. Task 7 commits a fixture written from Google's documentation with `provisional: true` and a `source` that says so; the attestation suite reports a test literally titled "PENDING: the committed fixture is PROVISIONAL…" on every run until Task 9's capture replaces it, at which point the same test becomes a live assertion. No task ships an empty or placeholder fixture.
5. **The live run's database is an ephemeral in-cluster pod**, not a managed instance. It is labelled not-for-production in the manifest, is reachable only by the proxy, and dies with the cluster.

**Placeholder scan.** No step says "add tests for the above", "handle errors appropriately", or "similar to Task N"; every code step carries the code, and every test step carries its assertions. The only `<placeholders>` are in Task 9's shell commands and evidence template, where the values are the user's project/region/run id and must **not** be committed.

**Type consistency across the renumbered tasks.**

- `proxyIp` is the field name in `KubernetesClusterInfo` and `KubernetesPreflightResult` and the parameter name of `waitForPolicyEnforcement`; `clusterIp` is the field inside `ProxyWitness` (it is a Service's ClusterIP before anyone calls it the proxy IP). Task 3 converts at the boundary, once, in `provision` and `runPreflight`.
- `platform` names the option on `RunPodOptions`, the field on `KubernetesJobConfig`, and the third parameter of `assertRunPodMatches`.
- `proxyDeny` is the canary key everywhere; `isEnforcementProbe` matches on `await tcp(8788)` in both `kubernetes.test.ts` (Task 3) and `kubernetes.integration.test.ts` (Task 8).
- `maxDiskMb` is the name on `ContainerExecutorConfig`, on `PlatformConfigCheck`, and on `KubernetesPreflightOptions` — added in Task 6 and in **no** snippet before it.
- The probe exit codes are `ENFORCEMENT_PROBE_PROVEN` / `_DENY_REACHABLE` / `_PROXY_UNREACHABLE`, defined in Task 3 and used by name in `kubernetes.ts`; the old private `ENFORCEMENT_PROBE_CONNECTED` is gone.
- `preflightTimeoutMs` / `readyTimeoutMs` on `KubernetesJobConfig` map to the **existing** `KubernetesPreflightOptions.timeoutMs` and `KubernetesJobLauncherOptions.readyTimeoutMs`; no option is renamed.
- The preflight check list is `["namespace", "proxy-service", "worker-image", "canary"]` after Task 3 and `["platform", "namespace", "proxy-service", "worker-image", "canary"]` after Task 6. Tasks 3, 6, 8 and 9 all use the list current at their point in the sequence.
