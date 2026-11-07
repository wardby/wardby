---
id: errors/coding-mcp-gateway-unavailable
title: A coding run failed before launch because the native gateway did not wake
summary: In low-power mode, the run failed with coding_failure_mcp_gateway_unavailable because the native gateway that serves its MCP tools did not wake in time.
audience: operator
tags: [error, mcp, coding-agents, low-power, coding_failure_mcp_gateway_unavailable, coding_mcp_gateway_unavailable]
appliesTo: ">=0.8.0"
---

# A coding run failed before launch because the native gateway did not wake

## What happened

The run's error starts with `coding_failure_mcp_gateway_unavailable`, followed
by a diagnostic id. It happens only in [low-power mode](../low-power-mode.md).

A coding run with MCP tools sends every MCP call through the coding proxy to
the native gateway (`wardby-native-gateway`). In low-power mode the gateway
may be scaled to zero, so before such a run launches, wardby wakes the gateway
together with the proxy and waits for a ready endpoint. The gateway did not
become ready in time, so wardby failed the run rather than start it without
its MCP tools. Nothing was launched, so the run made no changes.

The run's error contains only the code and the diagnostic id. The control
plane log has the cause at `warn`, under the same diagnostic id, with the
internal code `coding_mcp_gateway_unavailable` and the underlying wake error,
usually [`low_power_wake_timeout`](low-power-wake-timeout.md) or
[`low_power_scale_forbidden`](low-power-scale-forbidden.md).

## What to do

1. Search the control plane log for the diagnostic id and read the wake error.
2. For `low_power_wake_timeout`, check why the gateway pod did not become
   ready: `kubectl -n <namespace> describe deployment wardby-native-gateway`
   and the events of its pod. A cold Autopilot node can take a few minutes.
   The wait is at least 5 minutes; for coding runs a
   `KUBERNETES_READY_TIMEOUT_MS` above that, set on the control-plane
   Deployment, raises it.
3. For `low_power_scale_forbidden`, re-run `up.sh` with `WARDBY_LOW_POWER=1` to
   apply the `wardby-power` Role.
4. Trigger the agent again once the gateway is ready.

Runs without MCP tools do not wake the gateway and never fail this way.

See [Remote MCP servers for coding agents](../../docs/mcp-servers.md#coding-agents)
and [Low-power mode](../low-power-mode.md).
