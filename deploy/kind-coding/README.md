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
5. Builds and pushes the coding-worker image (`src/coding-worker/Dockerfile`)
   and the runtime image (`deploy/Dockerfile`, `runtime` target) to the
   registry, then resolves each one's pulled-by-digest reference.
6. Verifies the worker image has `tar`, `head`, and `test`, which the run pod's
   keeper uses to seed and collect the workspace.
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
```

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
RoleBindings to the Cloud Run service account's identity, which is the
least-privilege boundary in that deployment.

## Tear it down

```sh
bash deploy/kind-coding/down.sh
```

Deletes the `wardby` cluster and removes the `kind-registry` container. Both
steps tolerate the cluster/registry already being gone. This does not touch
your local Postgres (`deploy/local`) or anything in `.env.local`.
