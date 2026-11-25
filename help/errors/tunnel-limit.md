---
id: errors/tunnel-limit
title: Tunnel limit reached (tunnel_limit)
summary: The run has too many open tunnels or has used its byte allowance.
audience: operator
tags: [error, coding-agents, proxy, tunnel, tunnel_limit]
appliesTo: ">=0.10.1"
---

# tunnel_limit

`tunnel_limit` (HTTP 429) is an answer from the coding proxy's [CONNECT tunnel](../coding-proxy-tunnel.md). The body is fixed JSON and never repeats the host, the token or any header value.

The run already has `CODING_TUNNEL_MAX_CONNECTIONS` tunnels open, or its tunnels have carried `CODING_TUNNEL_MAX_BYTES` in both directions together. A tunnel that passes the byte limit is closed with the outcome `byte_cap`.

Fix: close idle connections or retry when one frees up. If the limits are too low for the workload, raise them on the proxy. Counts are kept by each proxy process on its own, so with several replicas a run may use up to the limit on each.
