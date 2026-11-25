---
id: errors/tunnel-unavailable
title: Tunnel authentication unavailable (tunnel_unavailable)
summary: The proxy could not check the tunnel token.
audience: operator
tags: [error, coding-agents, proxy, tunnel, tunnel_unavailable]
appliesTo: ">=0.10.1"
---

# tunnel_unavailable

`tunnel_unavailable` (HTTP 503) is an answer from the coding proxy's [CONNECT tunnel](../coding-proxy-tunnel.md). The body is fixed JSON and never repeats the host, the token or any header value.

The component that looks up tunnel tokens failed, for example because its database was unreachable. The request was refused rather than allowed.

Fix: retry. If it persists, look for `tunnel.auth_failed` in the proxy log; it records the error's class name only.
