---
id: errors/tunnel-host-not-allowed
title: Tunnel host not allowed (tunnel_host_not_allowed)
summary: The host is an IP address or is not on the tunnel allowlist.
audience: operator
tags: [error, coding-agents, proxy, tunnel, tunnel_host_not_allowed]
appliesTo: ">=0.10.1"
---

# tunnel_host_not_allowed

`tunnel_host_not_allowed` (HTTP 403) is an answer from the coding proxy's [CONNECT tunnel](../coding-proxy-tunnel.md). The body is fixed JSON and never repeats the host, the token or any header value.

The target is an IP address (any IPv4 or IPv6 literal, including forms like a decimal integer), or its name is not in `CODING_TUNNEL_ALLOWED_HOSTS`. Names match exactly: allowing `example.com` does not allow `sub.example.com`.

Fix: use the hostname rather than an address, and if the run should reach the host, add that exact name to `CODING_TUNNEL_ALLOWED_HOSTS`. Allowlist a shared host (an object store or CDN) only if you accept every tenant on it. The refused name is not written to the audit record.
