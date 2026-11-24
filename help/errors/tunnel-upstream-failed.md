---
id: errors/tunnel-upstream-failed
title: Tunnel upstream failed (tunnel_upstream_failed)
summary: The proxy could not open a connection to the allowed host.
audience: operator
tags: [error, coding-agents, proxy, tunnel, tunnel_upstream_failed]
appliesTo: ">=0.10.1"
---

# tunnel_upstream_failed

`tunnel_upstream_failed` (HTTP 502) is an answer from the coding proxy's [CONNECT tunnel](../coding-proxy-tunnel.md). The body is fixed JSON and never repeats the host, the token or any header value.

The name did not resolve, or the connection to the checked address was refused, reset or timed out (the proxy waits 15 seconds).

Fix: check that the host is reachable from the proxy pod on port 443, and that the proxy's own network policy allows public HTTPS egress. The underlying error is not sent to the client; the proxy log has the refusal code and run id.
