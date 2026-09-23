# Phase 12 — Kubernetes coding launcher: live evidence

Date: 2026-09-22. Branch `phase-12-foundations`. What a real cluster actually
proved, recorded so nobody has to take the plan's word for it. The launcher
itself is documented in [coding-worker-isolation.md](coding-worker-isolation.md);
the design and its post-implementation corrections are in
`docs/superpowers/specs/2026-09-22-phase-12-kubernetes-job-launcher-design.md`.

## Environment

- `kind` cluster `kind-wardby`, Kubernetes server **v1.37.0**, namespace
  `wardby-coding`, images from the local registry `localhost:5001`, control
  plane on the host (Node 24.12.0). The harness is `deploy/kind-coding/`.
- Network policy is enforced by kindnet, proven per-run by the preflight canary
  rather than assumed — see "Preflight" below.
- **No gVisor.** `runtimeClassName` is unset, so this configuration is
  development-only. GKE with gVisor is Plan 3.

## Preflight

`wardby coding preflight` passes all five checks against this cluster:

```
coding preflight passed (platform, namespace, proxy-service, worker-image, canary)
  for localhost:5001/wardby-coding-worker@sha256:f2d92d0f3871…
```

`platform` refuses an unrunnable configuration (a `runtimeClassName`/
`CODING_MAX_DISK_MB` the target platform can't satisfy) before any cluster
call. `proxy-service` reads the coding proxy's own Service and Endpoints as
the enforcement witness: it must expose both the proxy port `8787` and the
deny port `8788`, with a ready endpoint serving both. The canary is a real
run-shaped pod under the run NetworkPolicy; it proves the cluster blocks DNS,
the internet, the cloud metadata endpoint, and **the proxy's own deny port**,
while reaching the proxy itself — the witness moved off the cluster's DNS
service and onto the coding proxy's own second port, since 8787-reachable +
8788-blocked on the same pod is something only a programmed, port-scoped
NetworkPolicy can produce. It waits for policy enforcement before probing,
because a CNI programs a new pod's rules seconds after the pod starts —
without that wait the canary raced the CNI and passed on an unpoliced pod.
The launcher performs the same wait before releasing any worker.

**What the canary does not prove.** It is a _reduced_ pod: `runCanary` builds it
with `buildRunPod` and then drops the `keeper` container and replaces the
worker's command, and it is never read back and attested — no
`assertRunPodMatches` call exists on the canary path. So a green canary is
evidence about the cluster's _network_ enforcement only. It is not evidence
that the three-container run pod conforms to the platform's admission rules,
nor that the platform leaves it unmutated: a canary can pass on a cluster where
every real run pod is rewritten and fails attestation. On a platform with an
ephemeral-storage ceiling the canary is also the _cheaper_ pod (it reserves
less than `buildRunPod`'s pod-total guard charges it), so it cannot surface a
ceiling problem either. The dry-run capture, not the canary, is what proves
conformance.

## Integration suite

`npm run test:kubernetes` (gated on `WARDBY_KUBERNETES_TEST=1` plus a context
and a digest-pinned image; skipped by `npm test`) runs four tests against the
live cluster in ~66 s, repeatedly, leaving no `wardby-run-*` objects behind.
It proves an
attested, isolated pod; a safe diagnostic from a failing worker; `stop`;
refusal of a conflicting relaunch; and that the real API server's dry-run
create and version read both work as `ClientNodeKubernetesApi` expects. It
asserts the enforcement gate ran, and that the pod cannot reach the API
server's ClusterIP or the coding proxy's deny port — by the proxy's Service
ClusterIP and by the proxy pod's own IP — while it can reach the proxy on
`8787`, by pod IP and by its Service DNS name.

## Live smoke runs

Both used the Kubernetes launcher end to end on the cluster above, against the
fixture repository `chfields/knock-knock-jokes`, and both left a draft PR.

|           | Smoke 1 (baseline)            | Smoke 2 (functional)                  |
| --------- | ----------------------------- | ------------------------------------- |
| Run       | `cmud3ife80002sq5ebf7zfvvv`   | `cmud49yoz0002sqpaptretptl`           |
| Model     | `gpt-4.1-nano`                | `gpt-5.6-luna`                        |
| Toolchain | `node`                        | `node-python` 3.12                    |
| Task      | create one file with one line | add a pure domain helper + unit tests |
| Result    | succeeded, PR #29             | succeeded, PR #30                     |
| Duration  | 50.8 s                        | 66.3 s                                |
| Cost      | $0.001199 of $0.25            | $0.007421 of $0.50                    |

Smoke 2 is the one that matters: a real code change to `knockknock/ratings.py`
with four new tests, the repository's own suite run inside the pod (25 tests
green), and nothing else touched. Its assigned task had to be substituted at
dispatch time — the slice named in the plan had already been implemented on
`main` by an earlier test run — so an equivalently scoped missing piece was used
instead.

## Bugs this evidence exists because of

Every one of these was invisible to the unit suite and to the fake-cluster
tests. They are recorded because "the tests passed" would have been misleading.

1. **The keeper could not start.** kubelet pre-creates a worker's `subPath`
   mount targets root-owned, and the keeper runs as uid 10001 with every
   capability dropped, so its `chmod` failed and every launch timed out. Fixed
   with a `storage-init` init container that creates the directories first.
2. **Seeding hung forever.** A small workspace archive finished before the exec
   websocket connected, and its output was discarded; the remote `tar` then
   waited for input that never came.
3. **`fetch` was corrupted process-wide.** `@kubernetes/client-node` pulls
   undici 8, which takes over the hook Node's built-in fetch uses. Over HTTP/2
   the bridge hands the built-in handler the wrong header shape, so every
   response arrived with **zero headers and an undecompressed body**. The GitHub
   App client failed on every coding run; the OpenAI/Anthropic/Bedrock clients
   and BYO-IdP token verification were equally affected, on Docker deployments
   too, since the Kubernetes client is imported unconditionally. Fixed by
   pinning the shared dispatcher to HTTP/1.1 (`src/core/http-runtime.ts`).
4. **A refused run recorded only an opaque diagnostic id.** Finding (3) took a
   bisect because the real reason was discarded. The executor now logs a
   redacted reason and cause chain against the same id.
5. **The `node-python` image had no `python`.** Only `python3`, so a task
   following the repository's own README reported a failed test command while
   the suite was green.

## Known gaps

Carried into the follow-up plan (Plan 2b), which gates Plan 3:

- Per-run record ConfigMaps are kept as tombstones by design and never deleted;
  failed launches leave records too. Needs garbage collection; this also
  applies to any managed cluster the launcher is pointed at, including the
  Autopilot proof below.
- Plan 2b's remaining items are not a gate on this work: nothing below
  depends on them, and the launcher's out-of-namespace dependency
  (kube-system) is removed here rather than deferred.
- **The one residual way "blocked" is not conclusive.** The witness is now the
  coding proxy's deny port: the gate counts a probe only when 8787 connects and
  8788 does not, and both halves are measured from inside the pod in the same
  exec. What that still cannot separate is a _drop_ from an _exhausted accept
  backlog_. The probe runs in the keeper, which shares a network namespace with
  the untrusted worker, so code holding the deny port's accept queue full
  would make 8788 read as blocked while 8787 still connects — the proven
  outcome — without any policy being enforced. This is speculative, not a live
  finding. Nothing of the agent's runs before the gate opens -- the worker
  container executes wardby's gate script until the marker appears -- so
  attacker code at that moment means a hostile worker image
  (`agents:admin`-gated) or a compromised base. It requires the policy to
  _already_ be unenforced, so the network a fake would win is network the
  attacker already has, though a faked proof does buy more than that: the gate
  also withholds the seeded workspace and input, and the release itself. And it
  requires out-racing an
  accept-and-close loop that holds no connection open, with no `CAP_NET_RAW`
  and no raw sockets in the pod. Closing it properly means evidence the deny
  port produced a distinguishable _response_, not merely silence — which a
  listener that serves nothing cannot give — so it is recorded here rather than
  patched around.
- Spec §9 integration coverage not yet built: the shared launcher contract
  against a real API, OOM / disk-full / wall-clock containment, canary failure
  when a policy is removed, and the tool pod's lack of network.
- Redaction false negatives introduced with the new patterns: an RSA-8192 PEM
  body is not redacted at all, a pretty-printed JSON AWS key is missed, and URL
  user-info longer than 512 characters is missed. `vcs_git_config_unsafe` uses
  the same patterns as a detector, so it is correspondingly narrower.
- A dependency that installs its own dispatcher after start-up would silently
  restore HTTP/2 and finding (3) with it. No runtime guard today.
