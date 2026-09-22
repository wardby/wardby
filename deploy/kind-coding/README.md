# deploy/kind-coding

A local `kind` cluster that proves wardby's Kubernetes coding-run launcher
(`JOB_LAUNCHER=kubernetes`, `src/providers/jobs/kubernetes.ts`) end to end on
a laptop: the namespace, RBAC, default-deny networking, the in-cluster
coding proxy, and — most importantly — that `NetworkPolicy` is actually
enforced, which is what makes a coding-run pod's isolation real instead of
theoretical.

**This is a local proof harness, not a production deployment.** It has no
gVisor/runtime-class sandboxing and no cloud-provider Autopilot admission
rules; those are Plan 3's GKE overlay, which reuses the same
`manifests/base/` this harness uses.

## Prerequisites

- Docker Desktop (or another local Docker) running.
- [`kind`](https://kind.sigs.k8s.io/) ≥ 0.33, and `kubectl`.
- The local Postgres from `npm run db:up` (`deploy/local/docker-compose.yml`)
  already running on `:55432`. Don't re-run `db:up` if it's already up — it
  recreates the container.
- `.env.local` at the repo root with `DATABASE_URL`, `OPENAI_API_KEY`, and/or
  `ANTHROPIC_API_KEY` set (same values `npm run coding:local:up` uses for the
  Docker-launcher proxy).

## Bring it up

```sh
bash deploy/kind-coding/up.sh
```

This is idempotent — safe to re-run. In order, it:

1. Starts a local registry container (`kind-registry`) publishing
   `localhost:5001`, if one isn't already running.
2. Creates the `kind` cluster (`kind-config.yaml`; cluster name `wardby`,
   context `kind-wardby`), if it doesn't already exist.
3. Points every node's containerd at the registry and connects the registry
   to the cluster's Docker network, so `localhost:5001/...` image
   references resolve both from your shell (`docker push`) and from inside
   the cluster (image pulls).
4. Builds and pushes the coding-worker image (`src/coding-worker/Dockerfile`)
   and the runtime image (`deploy/Dockerfile`, `runtime` target) to the
   registry, then resolves each one's pulled-by-digest reference.
5. Verifies the worker image has `tar`, `head`, and `test` — the run pod's
   keeper (Task 5) depends on them for seeding and collecting the
   workspace.
6. Applies the namespace, then creates the proxy's `wardby-coding-proxy-env`
   Secret directly in the cluster from `.env.local`'s `DATABASE_URL`,
   `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY` — read into environment
   variables and piped straight into `kubectl`, never printed, never written
   to a tracked file. `DATABASE_URL`'s `localhost`/`127.0.0.1` host is
   rewritten to `host.docker.internal` so the in-cluster proxy can reach the
   Postgres published on your machine.
7. Renders `manifests/overlays/kind` with `kubectl kustomize`, substitutes
   the resolved runtime digest for the `wardby-runtime` placeholder image
   name, applies it, and waits for the proxy's rollout.
8. Prints the three lines below and the next command to run.

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
coding preflight passed (namespace, proxy-service, cluster-dns, worker-image, canary) for localhost:5001/wardby-coding-worker@sha256:...
```

## What the preflight proves — and what to do if it fails

`wardby coding preflight` (`src/providers/jobs/kubernetes-preflight.ts`) runs
five checks in order: the namespace exists, the proxy Service exists, the
cluster's `kube-dns` Service can be read (via
`launcher-dns-reader-role.yaml`'s Role), the worker image is a registry
digest, and — the check that matters most — a **canary** pod built from the
same pod spec and `NetworkPolicy` a real coding run gets. The canary proves
that from inside that policy: DNS resolution is blocked, a direct TCP
connect to the cluster DNS Service's ClusterIP is blocked, the internet is
blocked, the cloud metadata address is blocked, and the coding proxy _is_
reachable. If even one of those five conditions doesn't hold, the whole
point of running coding agents in Kubernetes — that a compromised or
malicious agent can't exfiltrate data or reach the metadata server — doesn't
hold either.

A failure reports `kubernetes_isolation_unsupported:canary` (any of the five
probes came back wrong) or `kubernetes_isolation_unsupported:timeout` (the
canary didn't finish within the preflight's bound). **If you see `:canary`
and the underlying cause is that a probe that should be blocked was actually
_reachable_, `kind`'s default network layer (kindnet's bundled
`kube-network-policies` controller) is not enforcing `NetworkPolicy` on this
machine.** That's a real gap, not something to work around by editing the
policy — stop and report it. The documented fallback is replacing kindnet
with [Calico](https://docs.tigera.io/calico/latest/getting-started/kubernetes/kind),
which does enforce `NetworkPolicy` everywhere:

1. Recreate the cluster with `disableDefaultCNI: true` added to
   `kind-config.yaml`'s `networking:` block (see the [kind
   docs](https://kind.sigs.k8s.io/docs/user/configuration/#disable-default-cni)).
2. Install Calico's kind-specific manifest, per [Calico's own
   instructions](https://docs.tigera.io/calico/latest/getting-started/kubernetes/kind):
   `kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/<version>/manifests/calico.yaml`
   (pin an actual released version — don't track `master`).
3. Re-run `bash deploy/kind-coding/up.sh` and `npm run cli -- coding preflight`.

This is a cluster rebuild, and doing it changes what the harness is proving
(kindnet vs. Calico enforcement), so treat switching to Calico as a
deliberate, recorded decision rather than a silent workaround.

## RBAC notes

Two `Role`s ship in `manifests/base/` with **no `RoleBinding`**:
`launcher-role.yaml`'s `wardby-coding-launcher` (in `wardby-coding`) and
`launcher-dns-reader-role.yaml`'s `wardby-coding-dns-reader` (in
`kube-system`, scoped to `get` on the single named Service `kube-dns`).
Neither is bound here because the `kind` control plane runs every command in
this harness — `up.sh`, `kubectl`, and `wardby coding preflight` — against
your own admin kubeconfig, which already has full access. Plan 3's GKE
overlay binds both Roles to the Cloud Run service account's identity, which
is the actual least-privilege boundary in a real deployment.

## Tear it down

```sh
bash deploy/kind-coding/down.sh
```

Deletes the `wardby` cluster and removes the `kind-registry` container. Both
steps tolerate the cluster/registry already being gone. This does not touch
your local Postgres (`deploy/local`) or anything in `.env.local`.
