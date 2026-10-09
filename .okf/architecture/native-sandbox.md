---
type: Architecture Pattern
title: Native sandbox
description: A native agent set to sandbox mode runs its whole turn loop and user tools in a single-use, credential-free worker whose only way out is the native gateway.
tags: [sandbox, security, native-agents, isolation]
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-10T00:00:00Z
sources:
  - id: native-sandbox-doc
    resource: /docs/native-sandbox.md
  - id: native-worker-dir
    resource: /src/native-worker
---

# Modes

Each native agent has a `nativeExecutionMode`:

- `control-plane` (default): the run executes in the server process, with user
  tools in the in-process [tool sandbox](/architecture/tool-sandbox.md).
- `sandbox`: the whole turn loop and the user tools run in a worker container
  (Docker) or pod (Kubernetes), chosen with `NATIVE_SANDBOX_LAUNCHER`.[^native-sandbox-doc]

Each run keeps the mode it started with. Coding agents do not use this; see
[coding workers](/architecture/coding-workers.md).

# Isolation

The worker holds no LLM keys, secrets, database URL or container-runtime
access. It runs non-root on a read-only root filesystem with CPU and memory
limits, and gets a run-scoped capability on stdin, never in its environment,
arguments or labels. Its only network path is the **native gateway** (port
8790), which makes model calls, serves built-in tools and enforces each tool
attachment's grants. Docker gives each run its own internal network; Kubernetes
gives each pod its own NetworkPolicy, optionally under gVisor.

On Kubernetes a run starts not ready. The server reads back the pod and policy
and compares them with what it built, then probes from inside the pod (gateway
reachable, deny port 8791, the internet and the metadata server unreachable)
before the gateway accepts calls. A mismatch or failed probe fails the run.

# Budget

The gateway is the budget authority for sandboxed runs: it reserves each model
call's worst case, calls the provider and settles at actual usage, so the
worker cannot overspend (see [budget guardrail](/architecture/budget-guardrail.md)).
Runs have a 60-minute maximum lifetime.

# Warm pool

`NATIVE_SANDBOX_WARM_POOL_SIZE` (default 0) keeps idle, already-isolated
workers that a run claims atomically through the database (`NativeWarmWorker`).
The run's input is delivered by exec over stdin only after the claim; the
worker is re-checked at claim and is still single-use. With no idle worker, or a
failed re-check, the run cold-launches.

# Code

`src/native-worker/`[^native-worker-dir]: `sandbox-executor.ts` (launch and
supervise), `docker-launcher.ts` and `kubernetes-launcher.ts` with their
`*-isolation.ts` builders, `gateway-server.ts` (the gateway), `worker.ts` and
`main.ts` (the worker), `warm-pool.ts` and `warm-pool-ledger.ts`. Error codes
are `native_sandbox_*`, documented in `help/errors/`.

[^native-sandbox-doc]: docs/native-sandbox.md

[^native-worker-dir]: src/native-worker
