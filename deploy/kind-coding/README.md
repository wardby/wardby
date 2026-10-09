# deploy/kind-coding

A local `kind` cluster that proves wardby's Kubernetes coding-run launcher
(`JOB_LAUNCHER=kubernetes`, `src/providers/jobs/kubernetes.ts`) end to end on
a laptop: the namespace, RBAC, default-deny networking, the in-cluster
coding proxy, and — most importantly — that `NetworkPolicy` is actually
enforced, which is what makes a coding-run pod's isolation real instead of
theoretical.

**The `kind` overlay is a local proof harness, not a production deployment.**
It has no gVisor/runtime-class sandboxing. The `gke-autopilot` overlay reuses
the same `manifests/base/` with the production runtime class, identity binding,
gateway, and provider-specific network rules.

## Prerequisites

- Docker Desktop (or another local Docker) running.
- [`kind`](https://kind.sigs.k8s.io/) ≥ 0.33, and `kubectl`.
- The local Postgres from `npm run db:up` (`deploy/local/docker-compose.yml`)
  already running on `:55432`. Don't re-run `db:up` if it's already up — it
  recreates the container.
- `.env.local` at the repo root with `DATABASE_URL`, `OPENAI_API_KEY`, and
  `ANTHROPIC_API_KEY` all set — `up.sh` requires all three, not "and/or"
  (same values `npm run coding:local:up` uses for the Docker-launcher
  proxy).

## Bring it up

```sh
bash deploy/kind-coding/up.sh
```

This is idempotent — safe to re-run (including to pick up new `.env.local`
values: step 9 restarts the proxy). In order, it:

1. Starts a local registry container (`kind-registry`) publishing
   `localhost:5001`: `docker run`s a new one if none exists, `docker
start`s it if it exists but is stopped, or leaves it alone if it's
   already running.
2. Creates the `kind` cluster (`kind-config.yaml`; cluster name `wardby`,
   context `kind-wardby`), if it doesn't already exist.
3. Points every node's containerd at the registry and connects the registry
   to the cluster's Docker network, so `localhost:5001/...` image
   references resolve both from your shell (`docker push`) and from inside
   the cluster (image pulls). A "the endpoint already exists" error from
   `docker network connect` is treated as already-done and ignored; any
   other error fails the script.
4. Applies kind's documented `local-registry-hosting` ConfigMap in
   `kube-public` ([KEP-1755](https://kind.sigs.k8s.io/docs/user/local-registry/)),
   so anything in-cluster that looks for it can find the registry.
5. Builds and pushes the coding-worker image (`src/coding-worker/Dockerfile`),
   the node-python coding-worker image (`src/coding-worker/Dockerfile.node-python`
   — used by agents whose `codingProfile.toolchain` is `"node-python"`, e.g.
   version `"3.12"`), the runtime image (`deploy/Dockerfile`, `runtime`
   target), and the Claude agent and tool-runner images
   (`src/claude-coding-worker/Dockerfile`, `src/claude-tool-runner/Dockerfile`
   — used by agents whose provider is `"claude-code"`) to the registry, then
   resolves each one's pulled-by-digest reference.
6. Verifies the coding-worker, node-python coding-worker, and Claude worker
   images have `tar`, `head`, and `test`, which the run pod's keeper uses to
   seed and collect the workspace.
7. Applies the namespace, then creates or updates the proxy's
   `wardby-coding-proxy-env` Secret directly in the cluster from
   `.env.local`'s `DATABASE_URL`, `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY`.
   Each name is read out of `.env.local` on its own (the file is never
   `source`d, so nothing else in it is ever exported); the Secret's YAML —
   `data:` values base64-encoded with bash's own `printf` builtin, never an
   external process — is assembled entirely in this script and piped
   straight into `kubectl apply -f -`. No value is ever passed as a
   command-line argument to `kubectl` or anything else (so nothing shows up
   in `ps`'s view of any process's argv), echoed, or written to a tracked
   file. `DATABASE_URL`'s `localhost`/`127.0.0.1` host is rewritten to
   `host.docker.internal` so the in-cluster proxy can reach the Postgres
   published on your machine.
8. Renders `manifests/overlays/kind` with `kubectl kustomize`, substitutes
   the resolved runtime digest for the `wardby-runtime` placeholder image
   name, and applies it.
9. Restarts the proxy Deployment (`kubectl rollout restart`) and waits for
   the rollout, so a Secret updated in step 7 on a re-run (e.g. after you
   changed a key in `.env.local`) actually reaches the running pod — a
   Secret update alone doesn't restart pods that already read it via
   `envFrom`.
10. Prints the three lines below and the next command to run.

Add the printed lines to `.env.local` — keep any previous Docker-launcher
values (`CODING_PROXY_CONTAINER`, etc.) commented out rather than deleted,
so you can switch back:

```dotenv
JOB_LAUNCHER=kubernetes
KUBERNETES_CONTEXT=kind-wardby
CODING_WORKER_IMAGE=localhost:5001/wardby-coding-worker@sha256:...
CODING_WORKER_IMAGE_NODE_PYTHON_3_12=localhost:5001/wardby-coding-worker-node-python@sha256:...
CODING_CLAUDE_WORKER_IMAGE=localhost:5001/wardby-claude-coding-worker@sha256:...
CODING_CLAUDE_TOOL_RUNNER_IMAGE=localhost:5001/wardby-claude-tool-runner@sha256:...
CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12=localhost:5001/wardby-claude-tool-runner-node-python@sha256:...
KUBERNETES_ENFORCEMENT_EXEC_TIMEOUT_MS=60000
```

The last one is `kind`-specific, not a copy-paste-everywhere default: a laptop
`kind` node's default resources (250m CPU / 128Mi memory on the keeper
container) can make even a healthy NetworkPolicy-enforcement probe take
noticeably longer than the launcher's normal 10 s per-probe budget
(`src/providers/jobs/kubernetes.ts`'s `waitForPolicyEnforcement`), which
otherwise fails every run with `kubernetes_exec_timeout` even though nothing
is actually wrong. GKE Autopilot has more headroom and doesn't need it. The
three probes of an enforcement streak run in one keeper exec, whose timeout the
launcher derives from this per-probe value (three probes plus the two 500 ms
gaps, i.e. 181 s at this value), and the overall enforcement wall-clock bound is
never shorter than one such exec, so raising only this one setting is enough.

Then run:

```sh
npm run cli -- coding preflight
```

Expected output:

```
coding preflight passed (platform, namespace, proxy-service, worker-image, canary) for localhost:5001/wardby-coding-worker@sha256:...
```

The proxy exposes a second port, **8788 — the deny port**. Nothing is served
there: it exists so that a coding-run pod which can reach the proxy on 8787 but
not on 8788 has proven its own NetworkPolicy is programmed _and_ port-scoped.
The proxy's policy deliberately allows ingress on 8788 from coding-run pods, so
the run pod's own egress policy is the only thing that can block it. The shared
resources live in `manifests/base/`; `manifests/overlays/kind/` provides the
local harness and `manifests/overlays/gke-autopilot/` provides the GKE target.

## Run a real coding agent locally

Preflight only proves the platform _can_ run an isolated coding pod; it never
runs one. To actually see a coding agent do work against this cluster:

1. **Migrations and the Prisma client must be current.** If you pulled new
   migrations, run `npx prisma migrate deploy` against the local Postgres and
   `npm run prisma:generate` before anything else — a stale client silently
   reads/writes the wrong columns instead of failing loudly.
2. **Set the launcher env** (`.env.local`, or exported in your shell) to
   what `up.sh` printed:
   ```dotenv
   JOB_LAUNCHER=kubernetes
   KUBERNETES_CONTEXT=kind-wardby
   CODING_WORKER_IMAGE=localhost:5001/wardby-coding-worker@sha256:...
   CODING_WORKER_IMAGE_NODE_PYTHON_3_12=localhost:5001/wardby-coding-worker-node-python@sha256:...
   CODING_CLAUDE_WORKER_IMAGE=localhost:5001/wardby-claude-coding-worker@sha256:...
   CODING_CLAUDE_TOOL_RUNNER_IMAGE=localhost:5001/wardby-claude-tool-runner@sha256:...
   CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12=localhost:5001/wardby-claude-tool-runner-node-python@sha256:...
   KUBERNETES_ENFORCEMENT_EXEC_TIMEOUT_MS=60000
   ```
   `CODING_WORKER_IMAGE_NODE_PYTHON_3_12` is only needed if the agent you
   trigger uses the `node-python` toolchain; a plain `node` Codex agent only
   needs `CODING_WORKER_IMAGE`, which a Claude-only setup can leave out. `CODING_CLAUDE_WORKER_IMAGE` and
   `CODING_CLAUDE_TOOL_RUNNER_IMAGE` are only needed to trigger an agent whose
   provider is `claude-code`, and `CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12`
   only for a `claude-code` agent on the `node-python` toolchain.
3. **coding agents can't be started with `wardby run`.** The CLI's `run`
   command refuses `kind: "coding"` agents on purpose — a coding run needs a
   repository, a base ref, and (for Task overrides) resource-sharing checks
   that only MCP's `trigger_agent` performs. If `.env.local` sets
   `MCP_TRANSPORT=http` for the long-running server, that's independent of
   what you use to trigger a run here: MCP's stdio transport
   (`loadMcpConfig`'s default) is a separate, short-lived process per
   invocation, not the same one `wardby serve` runs.
4. **Trigger it.** A committed helper, `scripts/local-trigger-agent.mjs`,
   spawns `wardby mcp` over stdio (forcing `MCP_TRANSPORT=stdio` for that
   child regardless of what `.env.local` says) and drives it with
   `@modelcontextprotocol/client`'s stdio transport — no separate MCP client
   needed:
   ```sh
   npm run build   # the script runs bin/wardby.js, not source
   node scripts/local-trigger-agent.mjs --list          # see visible coding agents
   node scripts/local-trigger-agent.mjs <agentId>        # trigger with its default task
   node scripts/local-trigger-agent.mjs <agentId> "fix the flaky test in foo.test.ts"
   ```
   It calls `list_agents` to resolve/validate the id, `trigger_agent`, then
   polls `get_run` every 5 s until the run reaches a terminal status
   (`succeeded`, `failed`, `refused`, `lost`, `budget_exhausted`, or
   `cancelled`), printing status transitions to stderr and a final
   status/error/cost/PR-url summary as JSON on stdout. The spawned `wardby
mcp` process's own stderr is forwarded, so a launcher or config error
   (e.g. a missing env var) is visible, not swallowed by the transport.
5. **Watching pods, don't confuse the two pod shapes.** `wardby coding
preflight` (step 8 above) schedules a **canary** pod — worker container
   only, no keeper — just to prove the platform and NetworkPolicy. A real
   triggered run's pod (`wardby-run-<token>`, `kubectl get pods -n
wardby-coding`) always has **two** containers: `keeper` (seeds the
   workspace, runs the enforcement probes, collects the result) and `worker`
   (runs the agent itself, gated until the keeper's seeded marker exists).
   If you only ever see one container, you're looking at a canary from a
   `preflight` run, not a triggered agent's run.

## Native sandbox on the kind harness

`up.sh` also sets up the [native sandbox](../../docs/native-sandbox.md) so
sandbox-mode native agents run as pods in this cluster
(`NATIVE_SANDBOX_LAUNCHER=kubernetes`). Beyond the coding-run steps above, it:

- builds and pushes the native worker image
  (`src/native-worker/Dockerfile`) and resolves its pulled-by-digest
  reference;
- creates or updates the gateway's `wardby-native-gateway-env` Secret from
  `.env.local` the same way as the proxy's (`DATABASE_URL`, `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, and `SECRET_APP_KEY`, which is **required** in
  `.env.local`: the gateway will not start without it), plus `GITHUB_APP_ID`
  and `GITHUB_APP_PRIVATE_KEY` when set, so sandboxed runs get the repository
  built-ins;
- applies the native gateway from `manifests/base/native-gateway.yaml`: a Deployment
  running `wardby native-gateway` with no service-account token and no RBAC, a
  ClusterIP Service exposing both the gateway port `8790` and the deny port
  `8791`, and a NetworkPolicy that admits `native-run` pods on both ports
  (`native-gateway-database-egress.yaml` in the kind overlay lets it reach the
  local Postgres), then restarts it and waits for the rollout.

The gateway is part of the shared base, so every overlay ships it. Each overlay
supplies its own database egress and the `wardby-native-gateway-env` Secret; the
`gke-autopilot` overlay also gives it its own Workload Identity and Cloud SQL
login (see `deploy/gke/README.md`).

Add the two extra lines `up.sh` prints to `.env.local`:

```dotenv
NATIVE_SANDBOX_LAUNCHER=kubernetes
NATIVE_SANDBOX_WORKER_IMAGE=localhost:5001/wardby-native-worker@sha256:...
```

Run pods and the gateway live in `wardby-coding`, so the server's namespace and
`KUBERNETES_CONTEXT=kind-wardby` settings above apply unchanged. Set an agent's
`nativeExecutionMode` to `sandbox` and trigger it; watch the run's pod with
`kubectl get pods -n wardby-coding -l wardby.io/component=native-run`. Before
the worker is allowed to call the gateway, the server proves the pod's
isolation from inside it (the gateway port answers, the deny port and an
outside address do not). On a `kind` cluster whose network layer does not
enforce `NetworkPolicy`, every sandbox run fails with
`native_sandbox_network_unenforced`; see the Calico fallback below.

To try the warm pool locally, also set `NATIVE_SANDBOX_WARM_POOL_SIZE=1` (the
long-running server then keeps one idle isolated worker pod, labelled
`wardby.io/pool=warm`, that the next run claims). See
[Warm pool](../../docs/native-sandbox.md#warm-pool).

An opt-in acceptance test exercises this end to end against the cluster. It is
skipped unless the `test:native-kind` script sets its flag:

```sh
NATIVE_TEST_KIND_WORKER_IMAGE=localhost:5001/wardby-native-worker@sha256:... npm run test:native-kind
```

Use the digest `up.sh` printed for `NATIVE_SANDBOX_WORKER_IMAGE`.

`npm run test:native-cluster` runs launcher-only isolation checks against any
cluster's deployed gateway, with no database or model needed. It requires
`NATIVE_TEST_WORKER_IMAGE` (a registry digest) and accepts
`NATIVE_TEST_CONTEXT`, `NATIVE_TEST_NAMESPACE`, `NATIVE_TEST_PLATFORM`,
`NATIVE_TEST_RUNTIME_CLASS`, `NATIVE_TEST_PRIORITY_CLASS`, and
`NATIVE_TEST_FORBIDDEN` (a list of `host:port` addresses that must be
unreachable from a worker).

## Load testing (contributors)

`manifests/overlays/kind-load` is the kind overlay plus a mock model upstream
inside the coding proxy: every model request gets a canned answer that ends
the run with no changes, after `WARDBY_LOAD_MOCK_LATENCY_MS` (default 5000).
Nothing reaches a model provider and no credentials are sent. Metering, the
ledger and audit still run; audit events carry `mockUpstream: true`.

The proxy only enables it when both `WARDBY_LOAD_TEST=1` and
`WARDBY_CODING_PROXY_MOCK_UPSTREAM=1` are set, and refuses to start with only
one. Never set them on a real deployment. Codex agents only.

Run the load test with `scripts/load/run-level-b.sh` (see its header).
Re-run `deploy/kind-coding/up.sh` from the same checkout first, so the proxy
image includes the mock upstream. While the test runs, the script replaces
the proxy's model keys with a placeholder and aborts unless every proxy pod
logs `proxy.mock_upstream_enabled`; it restores the original keys on exit.

## What the preflight proves — and what to do if it fails

`wardby coding preflight` (`src/providers/jobs/kubernetes-preflight.ts`) runs
five checks in order: the platform configuration can actually run (the
configured `runtimeClassName` and `CODING_MAX_DISK_MB` satisfy the target
platform's requirements — refused before a single cluster call), the
namespace exists, the proxy Service is a usable enforcement witness (it
exists, has a ClusterIP, exposes both the proxy port `8787` and the deny port
`8788`, and has a ready endpoint serving both), the worker image is a
registry digest, and — the check that matters most — a **canary** pod built
from the same pod spec and `NetworkPolicy` a real coding run gets. The canary
proves that from inside that policy: DNS resolution is blocked, a TCP connect
to the proxy's deny port is blocked, the internet is blocked, the cloud
metadata address is blocked, and the coding proxy _is_ reachable on `8787`.
Reaching `8787` while `8788` is blocked is what makes the result decisive: a
policy denial drops rather than rejects, so "8788 did not answer" alone would
also be what a dead proxy looks like. If even one of those five conditions
doesn't hold, the whole point of running coding agents in Kubernetes — that a
compromised or malicious agent can't exfiltrate data or reach the metadata
server — doesn't hold either.

A failure reports `kubernetes_isolation_unsupported:canary` (any of the five
probes came back wrong) or `kubernetes_isolation_unsupported:timeout` (the
canary didn't finish within the preflight's bound). **If you see `:canary`
and the underlying cause is that a probe that should be blocked was actually
_reachable_, `kind`'s default network layer (kindnet's bundled
`kube-network-policies` controller) is not enforcing `NetworkPolicy` on this
machine.** That's a real gap, not something to work around by editing the
policy — stop and report it. The documented fallback is replacing kindnet
with [Calico](https://docs.tigera.io/calico/latest/getting-started/kubernetes/kind),
which does enforce `NetworkPolicy` everywhere. Verified against Calico's own
kind quickstart (`docs.tigera.io/calico/latest/getting-started/kubernetes/kind`)
in Calico's current documentation. Re-check that page before following this,
since provider installation instructions change:

1. Recreate the cluster with `kind-config.yaml`'s `nodes:` block unchanged
   but a `networking:` block added:
   ```yaml
   networking:
     disableDefaultCNI: true
     podSubnet: 192.168.0.0/16
   ```
   (`disableDefaultCNI` turns off kindnet; `podSubnet` is the range Calico's
   own manifests below expect.) See also the [kind
   docs](https://kind.sigs.k8s.io/docs/user/configuration/#disable-default-cni).
2. Install Calico with its operator, per Calico's own kind instructions —
   three manifests, applied with `kubectl create` (not `apply`; Calico's
   docs note the CRD bundle can exceed `apply`'s request-size limit):
   ```sh
   kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/<version>/manifests/v1_crd_projectcalico_org.yaml
   kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/<version>/manifests/tigera-operator.yaml
   kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/<version>/manifests/custom-resources.yaml
   ```
   Pin `<version>` to an actual current release tag from Calico's releases
   page — don't track `master`, and don't reuse whatever version this doc
   happened to cite last.
3. Re-run `bash deploy/kind-coding/up.sh` and `npm run cli -- coding preflight`.

This is a cluster rebuild, and doing it changes what the harness is proving
(kindnet vs. Calico enforcement), so treat switching to Calico as a
deliberate, recorded decision rather than a silent workaround.

## RBAC notes

Two roles ship in `manifests/base/` with **no binding**:

- `launcher-role.yaml`'s Role `wardby-coding-launcher` (in `wardby-coding`)
  — only the verbs `ClientNodeKubernetesApi`
  (`src/providers/jobs/kubernetes-client.ts`) actually issues: no
  `list`/`watch` on `pods` (the seam only ever creates, reads, or deletes
  one named pod), no `get` on `secrets` (it only ever creates or deletes
  one). It also grants `get` on `endpoints`, scoped by `resourceNames` to the
  single object `wardby-coding-proxy` — the enforcement witness read
  (`src/providers/jobs/kubernetes-witness.ts`). Nothing in `kube-system` is
  read any more.
- `launcher-namespace-reader.yaml`'s **ClusterRole**
  `wardby-coding-namespace-reader`, scoped to `get` on the single named
  Namespace `wardby-coding`. This has to be a ClusterRole, not a Role: the
  preflight's first check against the cluster (`readNamespace` in
  `src/providers/jobs/kubernetes-preflight.ts`) is a `get` on the
  cluster-scoped `namespaces` resource, which no namespaced Role can ever
  grant.

None is bound in the `kind` overlay because the local harness runs `up.sh`,
`kubectl`, and `wardby coding preflight` against your admin kubeconfig. The
GKE overlay binds the ClusterRole with a ClusterRoleBinding and the Roles with
RoleBindings to the in-cluster control-plane ServiceAccount, which is the
least-privilege boundary in that deployment.

## Tear it down

```sh
bash deploy/kind-coding/down.sh
```

Deletes the `wardby` cluster and removes the `kind-registry` container. Both
steps tolerate the cluster/registry already being gone. This does not touch
your local Postgres (`deploy/local`) or anything in `.env.local`.
