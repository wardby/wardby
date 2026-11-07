---
id: errors/native-sandbox-unavailable
title: Native execution mode unavailable
summary: A run failed with native_sandbox_unavailable because its agent is in sandbox mode but the server has no native sandbox configured.
audience: operator
tags: [error, native-agents, sandbox, native_sandbox_unavailable]
appliesTo: ">=0.6.0"
---

# Native execution mode unavailable

`native_sandbox_unavailable` means the agent's `nativeExecutionMode` is `sandbox` but this deployment has no native sandbox configured. Wardby fails the run before any spend rather than running it unisolated.

1. To use the sandbox, set `NATIVE_SANDBOX_LAUNCHER=docker`, `NATIVE_SANDBOX_WORKER_IMAGE`, and `NATIVE_GATEWAY_CONTAINER` on the server that executes runs (`wardby serve` or `wardby scheduler`), start the native gateway, and restart the server.
2. Otherwise set the agent back to `control-plane` with `update_agent`.
3. Trigger the run again.

See [Run native agents in a sandbox](../native-sandbox.md) and the
[native sandbox guide](../../docs/native-sandbox.md).
