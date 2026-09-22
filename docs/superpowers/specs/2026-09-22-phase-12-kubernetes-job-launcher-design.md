# Phase 12: Kubernetes Job Launcher for Coding Agents — Design

**Date:** 2026-09-22
**Status:** Proposed (design approved section by section in brainstorming;
implementation plan to follow via writing-plans)
**Author:** wardby maintainer
**Related:** `docs/private/2026-09-21-phase-12-kubernetes-job-launcher-brief.md`
(options, cost estimate, why Kubernetes over Cloud Run Jobs);
`docs/coding-worker-isolation.md` (the Docker isolation model this design
must preserve or exceed); `src/providers/jobs/types.ts` (the `JobLauncher` /
`WorkspaceJobLauncher` contract); `src/providers/jobs/docker.ts`,
`src/providers/jobs/docker-isolation.ts` (the launcher and policy builder
this mirrors); `src/providers/executor/container.ts` (`ContainerExecutor`);
`src/providers/vcs/git.ts` (clone and finalization);
`docs/superpowers/specs/2026-09-17-gcp-control-plane-hosting-design.md`
(the Cloud Run control plane this attaches to).

> **Clean-room note.** Grounded in wardby's own code and docs listed above
> plus the public Kubernetes API and Google Cloud documentation. Copies no
> external codebase. Where this spec depends on a platform behavior that was
> not verified against the provider's own documentation during design, it is
> marked **(verify)** and the implementation plan must confirm it from the
> official docs before relying on it.

---

## 1. Goal and non-goals

**Goal.** Run Codex and Claude Code coding agents on a hosted deployment, at
scale, with isolation at least as strong as today's Docker model. Coding
runs execute as Kubernetes pods; the control plane (Cloud Run or any host)
drives them through the standard Kubernetes API. The first target is GKE
Autopilot behind the `deploy/gcp` control plane; the same launcher serves
EKS, AKS, on-prem Kubernetes, and a local `kind` cluster.

**Why.** Today coding agents run only where a Docker daemon is available to
the control-plane process. Cloud Run has none, so a hosted deployment can run
every agent kind except coding agents, and a coding run fails closed
(`JOB_LAUNCHER=local`). The Docker launcher also cannot scale beyond one host.

**First milestone scope (decided):** both providers, full isolation. Codex
and Claude Code run through the new launcher, network policies are enforced
and tested, Claude Code's tool pod is isolated, and each run can open a draft
PR.

**Non-goals (this milestone):**

- Cloning inside the cluster, and moving the Git finalizer into the cluster.
  The finalizer commits from a trusted control-plane checkout, so an
  in-cluster clone alone would not remove the control plane's copy; the real
  gain requires moving finalization (and a write-capable GitHub token) into
  the cluster, a trust-boundary redesign that needs its own design and review.
- Copying back only changed files. An optimization, not a correctness issue;
  it needs trusted-side change detection.
- A native ECS launcher. AWS uses this launcher on EKS.
- Changing the Docker launcher's behavior. It remains supported and its tests
  must keep passing.

## 2. Architecture

The control plane keeps its current responsibilities end to end;
**only the Docker-facing part is replaced.** `ContainerExecutor`, proxy
sessions, the Git finalizer, workspace validation, recovery, and cleanup are
unchanged. A new `KubernetesJobLauncher` implements `WorkspaceJobLauncher`,
exactly as `DockerJobLauncher` does.

**Components:**

- **Control plane** (MCP server, scheduler, `ContainerExecutor`, finalizer).
  New: `KubernetesJobLauncher`, selected by `JOB_LAUNCHER=kubernetes`; a
  database-backed concurrency gate in `ContainerExecutor` (§6).
- **One namespace per deployment** (default `wardby-coding`), containing:
  - the **coding proxy** as a Deployment + Service, the only workload with
    internet egress, holding the model credentials, with database access;
  - **per-run pods** (§3);
  - **per-run network policies** plus namespace-wide default-deny, and a
    `ResourceQuota` as a backstop.

**Run flow:**

1. Trigger → concurrency slot claimed, or the run queues (§6).
2. Shallow clone on the control plane (§4) → create the workspace pod →
   stream the workspace and input artifact in through the Kubernetes API.
3. Create the worker pod(s) and network policies → attest the effective specs
   (§5) → start.
4. Watch to terminal → collect the output artifact and, for `changes_ready`,
   the workspace.
5. Validate → finalizer commits, pushes, and opens a draft PR → remove every
   run resource.

**Control plane → cluster authentication.** On GKE, the control plane
authenticates as its Google service account; namespace-scoped Kubernetes RBAC
grants only what the launcher needs (§7). Locally, a kubeconfig. The launcher
uses only the standard Kubernetes API, so clusters differ in configuration
and Terraform, not code.

**Configuration.** `JOB_LAUNCHER=kubernetes` replaces the reserved, unused
`"ecs"` value in `JobLauncherKind` (`src/config/providers.ts`). New settings
(names finalized in the plan): namespace, cluster connection (in-cluster,
kubeconfig, or GKE endpoint), required runtime class, and digest-pinned
images for the Codex worker, Claude agent, Claude tool runner, and keeper.

## 3. Launcher and pod layout

**Keeper placement.** An `emptyDir` volume belongs to one pod and cannot be
mounted by another, so Docker's shared keeper volume does not map one-to-one.
Rather than introduce persistent volume claims, **the keeper is a container
inside the pod that owns the workspace.** Its role is unchanged: it holds the
volume, is the target for streaming files in and out, and keeps running after
the worker exits so results can be collected.

**Codex: one pod, two containers** (`keeper`, `worker`), sharing one volume
with today's four areas: `/workspace` read-write, input read-only, output
read-write, and no Git metadata (it stays on the control plane). Egress is
limited to the proxy.

**Claude Code: two pods**, preserving today's credential separation:

- **Workspace pod:** `keeper` + `tool`. Mounts the repository. No internet and
  no proxy access. Accepts only the relay connection from its own agent pod.
- **Agent pod:** `agent` only. Does not mount the repository. May reach only
  the proxy and its tool pod's relay port.
- **Relay:** moves from a Unix socket to TCP between the two pods, permitted
  only by network policy and authenticated with a random per-run token so
  nothing else in the namespace can use it. The launcher supplies the tool
  pod's address to the agent; neither side takes it from untrusted input.

**Contract mapping** (the invariants documented in `types.ts`):

| Method                 | Behavior                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch`               | Resource names derive from the run ID, so a repeated launch for an identical spec converges on the existing resources; a different spec for the same run ID is rejected. Handle: `{ backend: "kubernetes", id: "<namespace>/<run>" }`. |
| `status`               | From pod and container states, including exit codes, OOM kills, and image-pull failures. Terminal states never change.                                                                                                                 |
| `collect`              | Reads the output artifact through the keeper, bounded by today's artifact size limit. Repeatable until `remove`.                                                                                                                       |
| `materializeWorkspace` | Streams the workspace out through the keeper into control-plane staging (§4), then runs today's validation.                                                                                                                            |
| `stop`                 | SIGTERM, then kill after the grace period. Idempotent, best effort.                                                                                                                                                                    |
| `remove`               | Deletes every resource labeled for the run (pods, network policies, the per-run Secret). Refuses while the run is active. Idempotent.                                                                                                  |

No operation relaunches a missing, stopped, or removed job.

**Storage.** The workspace volume is disk-backed (node ephemeral storage, not
`medium: Memory`), sized per agent (§4). `/tmp` and the home directory stay
small RAM-backed volumes.

**Images.** Pinned by digest and pulled from a registry (Artifact Registry on
GKE, a local registry beside `kind`).

## 4. Workspace transfer and large repositories

**Clone (control plane, shared VCS code in `vcs/git.ts`).** Add `--depth 1`
to today's `--no-checkout --single-branch --no-tags` clone. Revision-in-place
continuations clone the existing branch at depth 1. The Docker launcher
benefits too. **The plan must verify** that the finalizer's pre-push checks
(branch ancestry, "remote has not moved") work with depth-1 history; where a
check needs more, deepen the clone just enough rather than drop the check.

**Seeding (control plane → keeper).** The control plane creates a tar of the
checked-out tree and streams it through the Kubernetes exec API into the
keeper, which extracts it into `/workspace`. The input artifact goes into the
read-only input area the same way. The keeper image is a small,
digest-pinned trusted image whose only job is extracting and archiving.
Streaming uses the official client (`@kubernetes/client-node`), with timeouts
and cancellation tied to the run deadline.

**Collecting (keeper → control plane).**

- Output artifact: bounded read; anything over the existing artifact limit
  fails the run.
- Workspace (only for `changes_ready`, as today): the keeper streams a tar;
  the control plane extracts it with a **strict extractor** that rejects
  absolute paths, `..` components, symlinks and hard links, device and other
  special entries, and enforces byte and entry limits while streaming. Then
  the existing `validateMaterializedWorkspace` runs unchanged (special files,
  nested `.git`, escaping symlinks, size limits, protected paths).

**Limits.** A new per-agent volume size in the coding profile (default 2 GiB,
today's `CODING_DISK_MB` default) bounds the workspace both ways. The existing
100,000-entry limit and diff limits (1,000 files / 1 MiB) are unchanged in
this milestone.

## 5. Isolation and attestation

A canonical policy builder, `kubernetes-isolation.ts` (mirroring
`docker-isolation.ts`), produces every pod spec and network policy; nothing
else constructs them.

**Every coding pod:**

- UID/GID `10001`, `runAsNonRoot`, `allowPrivilegeEscalation: false`, all
  capabilities dropped (including `NET_RAW`), seccomp `RuntimeDefault`,
  read-only root filesystem.
- `automountServiceAccountToken: false` and a dedicated service account with
  no RBAC permissions: workers cannot reach the Kubernetes API.
- No host network, PID, or IPC; no host paths; `enableServiceLinks: false`.
- CPU, memory, and ephemeral-storage requests equal to limits; the wall-clock
  deadline is enforced by the launcher.
- `runtimeClassName: gvisor` **required on GKE**. On `kind` there is no
  gVisor; the launcher logs a loud "development cluster: no gVisor" warning
  and the deployment is treated as development-only.
- The run capability is delivered through a per-run Secret referenced as an
  environment variable, never in the pod spec or arguments, and deleted in
  `remove`.

**Network policies (namespace default-deny for ingress and egress):**

| Pod                                  | Egress allowed                                                                            | Ingress allowed                |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------ |
| Codex worker, Claude agent           | Proxy pods, proxy port only                                                               | None                           |
| Claude workspace pod (tool + keeper) | None                                                                                      | Own agent pod, relay port only |
| Proxy                                | Internet on 443 excluding private, loopback, link-local and metadata ranges; the database | Worker and agent pods          |

**DNS is denied to worker and agent pods.** The launcher passes the proxy's
address directly, closing DNS as an exfiltration channel and matching
today's "no custom DNS" rule.

**Attestation, fail closed.**

- _Before start:_ read back every created pod and policy and compare the
  effective settings with the builder's output, including the runtime class
  actually applied (Autopilot may mutate pods). Any mismatch fails the run
  with the fixed code `kubernetes_isolation_unsupported`. No fallback to a
  weaker profile, as today.
- _Enforcement:_ the API cannot show whether network policies are enforced.
  `wardby coding preflight`, and the launcher once at startup, run a
  short-lived canary pod that attempts forbidden connections (internet,
  metadata server, DNS, another pod) and requires every attempt to fail. If
  any succeeds, coding execution stays disabled.

**Known gap.** Kubernetes has no per-pod process limit that Autopilot lets
tenants set **(verify)**. gVisor is the mitigation; the adversarial suite
measures fork-bomb containment and records the result. The gap is documented,
not hidden.

## 6. Concurrency and queueing

Lives in `ContainerExecutor`, so Docker-host deployments get it too.

**Configuration.** `CODING_MAX_CONCURRENT` (positive integer, default 4) caps
coding runs holding a slot, across every control-plane replica.
`CODING_QUEUE_TIMEOUT_SEC` (default 3600): a run queued longer fails with
the fixed reason `coding_queue_timeout`.

**Claiming a slot** (first step of `start`, before any clone or pod). One
transaction takes an advisory lock, counts coding runs that hold a slot and
are not terminal, and marks this run as holding one if under the cap;
otherwise the run stays `pending`, marked queued. Slot usage is **derived
from run state**, not a separate counter: a run that finishes, fails, is
stopped, or is reconciled to `lost` stops counting, so a crashed replica
cannot leak slots. Correctness across replicas comes from the database, as
with the scheduler's claim (`scheduler.ts`), never from process memory.

**Starting queued runs.** The scheduler tick (lease holder only) claims slots
for the oldest queued coding runs, oldest first, and starts them through the
executor. A finishing run also attempts an immediate start in its own
process, so freed slots are usually reused within seconds rather than the
next tick.

**Budgets.** The pre-flight budget check runs before queueing (a run that
would be refused never waits) and again at start.

**Visibility.** `get_run` / `list_runs` show a queued run as `pending` with a
`queued` coding phase and its enqueue time.

**Multiple deployments on one cluster.** Each deployment has its own namespace
and cap; the namespace `ResourceQuota` bounds total CPU, memory, and storage
regardless of run count. Wardby's cap counts runs; the quota bounds resources.

**Schema change.** New nullable columns on `CodingRun` (slot claimed at,
queued at) and an index supporting "oldest queued". Per CLAUDE.md: a
hand-written additive migration, matching `@@index` declarations, and a clean
drift check, in the same change.

## 7. Deployment

**One set of manifests, two overlays.** Namespace, control-plane RBAC, proxy
Deployment/Service/service account, default-deny policies, and the
`ResourceQuota` are plain manifests with kustomize overlays for `kind` and
GKE, applied with `kubectl`. Terraform owns cloud infrastructure; the
manifests own in-cluster objects. EKS later adds an overlay. Deploys stay
manual and documented (no CI/CD).

**Local harness: `deploy/kind-coding/`** (in the style of
`deploy/keycloak-test/`):

- A `kind` cluster config with a policy-enforcing network layer. First verify
  whether `kind` 0.33's default network layer enforces NetworkPolicy
  **(verify)**; if not, the config installs Calico. The preflight canary
  proves enforcement either way.
- A local registry beside the cluster, so images are pulled by digest as on
  GKE.
- Up/down scripts: create cluster and registry, push images, apply the
  overlay.
- The control plane runs on the host (`wardby serve`) with a kubeconfig; the
  proxy runs in-cluster and reaches local Postgres via `host.docker.internal`.

Standalone `kind` is used rather than Docker Desktop's built-in Kubernetes:
Docker Desktop's kind mode requires switching to the containerd image store,
which would hide the existing worker images and invalidate the pinned image
IDs the Docker launcher uses.

**GKE in `deploy/gcp`: optional, off by default** (e.g.
`enable_coding_cluster = false`), like Cloud Armor. When enabled:

- A regional GKE Autopilot cluster with GKE Sandbox available **(verify
  availability and pricing on Autopilot)**.
- The cluster's DNS-based API endpoint with Google IAM authentication, so the
  Cloud Run control plane connects without IP allowlists (Cloud Run egress
  addresses are not fixed) **(verify)**.
- The control plane's service account gets only the cluster-level role needed
  to connect; namespace permissions come from the manifests' RBAC bound to
  that identity. Permissions: pods (create, get, list, watch, delete),
  `pods/exec`, secrets (per-run), and network policies, in the one
  namespace. No `pods/log`: diagnostics stay fixed worker-owned codes, never
  raw pod output (§8).
- A Workload Identity binding so the proxy's Kubernetes service account
  reaches Cloud SQL through Google's connector and reads model API keys from
  Secret Manager **(verify the Autopilot-supported Secret Manager
  integration)**.
- Control-plane settings: `JOB_LAUNCHER=kubernetes`, namespace, cluster
  endpoint, digest-pinned images.
- `SETUP.md` additions: building and pushing worker images to Artifact
  Registry, applying the GKE overlay, `wardby coding preflight`, the added
  cost (cluster fee plus pods; see the brief), and teardown order (namespace,
  then cluster).

## 8. Error handling

- Fixed, sanitized failure categories, consistent with today's
  `failureCategory`: `kubernetes_isolation_unsupported` (attestation or
  preflight failure), `coding_queue_timeout`, image-pull failure, OOM,
  deadline exceeded, workspace limit exceeded, extractor rejection. No raw
  pod logs, task text, repository content, or credentials in errors or
  events.
- Provisioning ambiguity (a proxy session without a persisted job handle) is
  handled exactly as today: never relaunched, reconciled to `lost`, cleaned up
  from the persisted handle.
- Kubernetes API errors during `remove` are retried idempotently; resources
  are found by run label, so partial cleanup converges.

## 9. Testing and acceptance

**Unit (normal `npm test`, no cluster):**

- Policy builder: every pod spec and policy satisfies §5 (no service-account
  token, capabilities dropped, DNS denied, tool pod without egress, etc.).
- Attestation: the comparator rejects every single-field deviation, including
  a missing runtime class or mutated security context.
- Strict extractor: malicious archives (`..`, absolute paths, symlinks, hard
  links, devices, oversized entries, entry-count overflow) rejected mid-stream.
- Launcher lifecycle against a fake Kubernetes API, **running the existing
  `src/providers/jobs/contract-suite.ts`** that the Docker launcher passes.
- Concurrency (database-backed): simulated replicas racing for slots yield
  exactly the cap; oldest-first dequeue; queue timeout; a `lost` run frees its
  slot; budget refusal before queueing.
- Shallow clone: finalizer checks pass or deepen as designed.

**Integration on `kind`** (gated like today's Docker integration tests, e.g.
`npm run test:kubernetes`, skipped without a cluster):

- The contract suite against the real API.
- An isolation acceptance suite mirroring `test:docker-isolation`: forbidden
  egress fails (internet, metadata, DNS, other pods); the tool pod has no
  network; the agent pod has no repository; read-only root filesystem,
  non-root, no capabilities, no Kubernetes token; OOM, disk-full, and
  wall-clock limits contained.
- The preflight canary fails when a network policy is removed.

**Live smoke on `kind`:** Codex and Claude Code runs triggered over MCP
against a throwaway test repository, each opening a draft PR via the existing
GitHub App.

**GKE acceptance (the paid milestone):** the same smoke from the Cloud Run
control plane; gVisor confirmed from the pod spec and from inside the pod;
Autopilot mutations pass attestation; fork-bomb containment measured and
recorded; more runs than the cap triggered, showing queueing with every run
completing; clean teardown.

**Evidence** is recorded in a release-gate document modeled on
`docs/phase-5-release-gate.md`. The Docker launcher and its tests are
untouched and must keep passing.

## 10. Open items the plan must resolve

1. Per-pod process limits on Autopilot, and gVisor's containment of them.
2. GKE Sandbox availability, pricing, and minimum pod sizes on Autopilot
   versus the keeper's real needs.
3. `kind` 0.33 NetworkPolicy enforcement, or Calico.
4. GKE DNS-based endpoint with IAM for the Cloud Run control plane.
5. Autopilot-supported Secret Manager integration for the proxy.
6. Depth-1 clones against the finalizer's pre-push checks and
   revision-in-place.
7. Final names for the new configuration keys and `CodingRun` columns.
