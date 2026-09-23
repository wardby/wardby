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
coding preflight passed (namespace, proxy-service, cluster-dns, worker-image, canary)
  for localhost:5001/wardby-coding-worker@sha256:f2d92d0f3871…
```

The canary is a real run-shaped pod under the run NetworkPolicy. It proves the
cluster blocks DNS, the internet, the cloud metadata endpoint and the cluster's
own DNS service, and reaches only the proxy. It waits for policy enforcement
before probing, because a CNI programs a new pod's rules seconds after the pod
starts — without that wait the canary raced the CNI and passed on an unpoliced
pod. The launcher performs the same wait before releasing any worker.

## Integration suite

`npm run test:kubernetes` (gated on `WARDBY_KUBERNETES_TEST=1` plus a context
and a digest-pinned image; skipped by `npm test`) runs three tests against the
live cluster in ~66 s, repeatedly, leaving no `wardby-run-*` objects behind. It
proves an attested, isolated pod; a safe diagnostic from a failing worker;
`stop`; and refusal of a conflicting relaunch. It asserts the enforcement gate
ran, and that the pod cannot reach the cluster DNS pod or the API server while
it can reach the proxy.

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
  failed launches leave records too. Needs garbage collection.
- **The one residual way "blocked" is not conclusive.** The witness is now the
  coding proxy's deny port: the gate counts a probe only when 8787 connects and
  8788 does not, and both halves are measured from inside the pod in the same
  exec. What that still cannot separate is a _drop_ from an _exhausted accept
  backlog_. The probe runs in the keeper, which shares a network namespace with
  the untrusted worker, so a worker holding the deny port's accept queue full
  would make 8788 read as blocked while 8787 still connects — the proven
  outcome — without any policy being enforced. This is speculative, not a live
  finding: it requires the policy to _already_ be unenforced (i.e. the attacker
  already has the open network the gate exists to deny, so it buys reachability
  it already has rather than obtaining it), and it requires out-racing an
  accept-and-close loop that holds no connection open, with no `CAP_NET_RAW`
  and no raw sockets in the pod. Closing it properly means evidence the deny
  port produced a distinguishable _response_, not merely silence — which a
  listener that serves nothing cannot give — so it is recorded here rather than
  patched around.
- Autopilot's admission mutations will fail deny-by-default attestation until
  the allowances are written.
- Spec §9 integration coverage not yet built: the shared launcher contract
  against a real API, OOM / disk-full / wall-clock containment, canary failure
  when a policy is removed, and the tool pod's lack of network.
- Redaction false negatives introduced with the new patterns: an RSA-8192 PEM
  body is not redacted at all, a pretty-printed JSON AWS key is missed, and URL
  user-info longer than 512 characters is missed. `vcs_git_config_unsafe` uses
  the same patterns as a detector, so it is correspondingly narrower.
- A dependency that installs its own dispatcher after start-up would silently
  restore HTTP/2 and finding (3) with it. No runtime guard today.
