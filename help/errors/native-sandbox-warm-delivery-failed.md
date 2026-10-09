---
id: errors/native-sandbox-warm-delivery-failed
title: Native sandbox warm worker could not take the run
summary: A run claimed an idle warm-pool worker, delivering its input failed, and the worker could not be confirmed stopped within 30 seconds, so the run failed instead of cold-launching.
audience: operator
tags: [error, native-agents, sandbox, warm-pool, kubernetes, docker, native_sandbox_warm_delivery_failed]
appliesTo: ">=0.5.4"
---

# Native sandbox warm worker could not take the run

`native_sandbox_warm_delivery_failed` means a sandbox run claimed an idle worker from the warm pool (`NATIVE_SANDBOX_WARM_POOL_SIZE`), but writing the run's input into that worker failed. The worker may already hold the run's one-time gateway capability, so Wardby removes it and waits up to 30 seconds for it to be confirmed gone before starting a cold worker. This error means it could not be confirmed gone in that time, so the run failed rather than risk two workers holding the same capability. If the worker is confirmed gone, the run cold-launches and you see no error (the log has a `fallback` event).

1. Trigger the run again. Most failures are transient.
2. Check that the worker is gone: `kubectl get pods -n <namespace> -l wardby.io/pool=warm` (Kubernetes) or `docker ps --all --filter label=io.wardby.pool=warm` (Docker). Pool upkeep removes leftovers, but a stuck pod usually means the node or Docker host is unhealthy.
3. Look for `native-warm-pool` log entries with `event` `fallback`, and check that the server may exec into pods in the run namespace.
4. To bypass the pool while you investigate, set `NATIVE_SANDBOX_WARM_POOL_SIZE=0`; every run then cold-starts.

See [Run native agents in a sandbox](../native-sandbox.md) and the
[native sandbox guide](../../docs/native-sandbox.md#warm-pool). A related error is
[native_sandbox_capacity](native-sandbox-capacity.md).
