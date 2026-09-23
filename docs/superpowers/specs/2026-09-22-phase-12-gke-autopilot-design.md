# Phase 12 Plan 3a — running the Kubernetes coding launcher on GKE Autopilot

Date: 2026-09-22. Builds on
[the launcher design](2026-09-22-phase-12-kubernetes-job-launcher-design.md) and the
evidence from its `kind` proof in `docs/phase-12-kubernetes-evidence.md`.

**Goal:** one real coding run on a GKE Autopilot cluster, sandboxed with gVisor,
with the deny-by-default attestation intact.

Two things block that today, and both are described below. Everything else in
`docs/phase-12-kubernetes-evidence.md` § Known gaps stays deferred.

## Why the current build cannot run on Autopilot

1. **The enforcement witness does not exist there.** Before releasing a worker,
   the launcher proves the run's NetworkPolicy is actually being enforced by
   connecting to the cluster's DNS service and requiring the connection to be
   blocked. Autopilot has no kube-dns: Cloud DNS is the only provider for
   Autopilot since 1.25.9-gke.400, so there are no DNS pods to probe. The
   preflight fails closed on `cluster-dns` and nothing runs.
2. **Autopilot rewrites submitted pods.** It raises CPU below its 250m minimum,
   rounds CPU to 0.25 vCPU steps, scales a resource up to satisfy a 1:1–1:6.5
   memory:CPU ratio, sets limits equal to requests, and adds its own metadata.
   Attestation compares the pod read back from the API server against the pod we
   built and fails on any difference, which is exactly what catches tampering —
   so on Autopilot every run fails.

Facts above are from Google's documentation (sandbox-pods, kube-dns,
autopilot-resource-requests, autopilot-security), checked 2026-09-22.

## Decision 1 — the witness becomes the proxy's deny port

The witness must be something that answers when it is not blocked. Otherwise a
refused connection proves nothing, and a cluster with no enforcement passes.

The coding proxy already runs in the namespace on every deployment. It gains a
second listener — the **deny port** — that no run's NetworkPolicy ever permits.
The run policy continues to allow exactly one destination: the proxy on 8787.

A pod probing both ports produces a decisive result:

| proxy:8787 | proxy:deny port | meaning                                                 |
| ---------- | --------------- | ------------------------------------------------------- |
| connects   | blocked         | enforcement is live and port-scoped — proceed           |
| connects   | connects        | policy not enforced — refuse the run                    |
| blocked    | blocked         | policy not yet programmed — keep waiting, then time out |

This is stronger than the probe it replaces. The DNS probe could only show that
some address was unreachable; the deny port shows the policy discriminates by
port on a single destination pod, which cannot happen by accident.

It also removes work: the `cluster-dns` preflight check, the
`endpoints`/`services` grants in `kube-system`, and the `wardby-coding-dns-reader`
Role all disappear. The launcher stops depending on anything outside its own
namespace.

**Guarding against a vacuous pass.** If nothing listens on the deny port, "blocked"
is meaningless. The preflight therefore verifies, before trusting any probe, that
the proxy Service exposes both ports and has at least one ready endpoint. Both
reads are in wardby's own namespace, which the launcher Role already permits.

**Both users change together.** The preflight canary and the per-launch gate use
the same target. The gate keeps its current shape: three consecutive blocked
results, three seconds per attempt, bounded by `enforcementTimeoutMs`, failing
with `kubernetes_policy_not_enforced`.

## Decision 2 — conform first, then allow what remains

Attestation stays deny-by-default. Two changes make that survivable on Autopilot.

**Emit values Autopilot will not touch.** The builder derives conforming
resources from the requested spec: CPU rounded up to the platform's increment and
floor, memory adjusted to sit inside the permitted ratio, `ephemeral-storage`
requests set equal to limits, and every container given explicit values. What we
ask for is then what runs — today a request for 100m CPU silently becomes 250m,
and nothing tells the operator.

Where a request cannot be made to conform, the launch fails with a named error
rather than being quietly adjusted. Requesting a 16 GiB workspace on Autopilot is
the motivating case: Google rejects any pod over 10 GiB of ephemeral storage, so
wardby refuses it itself, with a message naming the cap.

**Write the remainder down.** Whatever Autopilot still adds — labels, annotations,
and any field its admission controller stamps on — is captured in a named platform
profile and normalized away on both sides of the comparison before it runs.
Anything outside that list still fails the run.

The profile is discovered, not guessed: a server-side dry-run create returns the
mutated object without scheduling anything, so the exact mutation set can be read
from a real cluster for the price of an API call. That dry run is a development
tool, run deliberately and reviewed, never a runtime authority — the admission
chain that produces the mutations is the same one an attacker with cluster access
would subvert, so it cannot be trusted to bless itself at launch time.

## Design

### Platform profiles

A new setting, `KUBERNETES_PLATFORM`, selects a profile: `generic` (the default,
today's behaviour, unchanged) or `gke-autopilot`. A profile carries:

- resource rules: CPU floor and increment, the memory:CPU ratio band, the
  ephemeral-storage ceiling
- the metadata Autopilot adds, as exact keys or key prefixes, normalized away
  before comparison
- whether gVisor is required

Profiles live beside the isolation builders and are pure data plus a normalizer,
so a reviewer can read the full list of tolerated differences in one place. The
`generic` profile tolerates nothing beyond what ships today.

### gVisor

On Autopilot, sandboxing needs one field: `runtimeClassName: gvisor` (GKE
1.27.4-gke.800+). No node pool, toleration or nodeSelector. The builder already
emits `runtimeClassName` from configuration.

The spec requires gVisor on GKE, so the `gke-autopilot` profile makes it
mandatory: an unset or non-`gvisor` runtime class fails at startup rather than
producing today's warning. Sandboxed pods are also exempt from Autopilot's
automatic seccomp profile, so the profile records how the field comes back.

### Startup validation

Under `gke-autopilot`, the preflight additionally refuses when:

- `CODING_MAX_DISK_MB` exceeds the 10 GiB ephemeral-storage ceiling
- the configured runtime class is not `gvisor`
- the proxy Service does not expose the deny port, or has no ready endpoint

Each failure names the setting and the limit. A configuration that cannot work is
rejected at startup, not at the first coding run.

### What does not change

The pod layout, the gate marker, the capability Secret, the record ConfigMap, the
workspace extraction, the queue and the concurrency cap are all untouched. So is
the comparator's deny-by-default character: profiles narrow what counts as an
expected difference, they never disable the comparison.

## Testing

- Unit tests per profile for the resource derivation, including values that
  cannot conform.
- Attestation tests against a recorded Autopilot mutation fixture, captured from a
  real dry run and committed, so the profile's list is exercised without a
  cluster.
- Rejection tests proving that a mutation outside the profile still fails, and
  that the `generic` profile tolerates nothing new.
- The existing `kind` integration suite continues to pass unchanged, now probing
  the proxy's deny port instead of cluster DNS.
- One live run on Autopilot with gVisor, recorded in the evidence document.

## Risks and open questions

- **The deny port is a new listener on a trusted component.** It must serve
  nothing: accept the connection, close it, no routing, no credentials. Its own
  policy must still allow it to exist while forbidding run pods from reaching it.
- **Autopilot's mutation set may differ by cluster version or compute class.** The
  profile is captured from one cluster; a different version could add something
  new, which fails closed and shows up as a rejected run rather than a silent
  pass. The dry-run tool makes re-capturing cheap.
- **Performance-class storage is untested.** Larger workspaces on Autopilot may be
  possible through the performance compute class or per-run PersistentVolumes;
  both are deferred until a repository actually needs more than 10 GiB.
- **Cost.** An Autopilot cluster bills a control-plane fee whenever it exists.
  Nothing in this design creates billable resources without explicit approval.
