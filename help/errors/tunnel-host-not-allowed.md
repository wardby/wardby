---
id: errors/tunnel-host-not-allowed
title: Tunnel host not allowed (tunnel_host_not_allowed)
summary: The host is an IP address, or is neither on the tunnel allowlist nor matched by one of the run's own tunnel hosts.
audience: operator
tags: [error, coding-agents, proxy, tunnel, tunnel_host_not_allowed, tunnelHosts]
appliesTo: ">=0.10.2"
---

# tunnel_host_not_allowed

`tunnel_host_not_allowed` (HTTP 403) is an answer from the coding proxy's [CONNECT tunnel](../coding-proxy-tunnel.md). The body is fixed JSON and never repeats the host, the token or any header value.

The target is an IP address (any IPv4 or IPv6 literal, including forms like a decimal integer), or its name is neither in `CODING_TUNNEL_ALLOWED_HOSTS` nor matched by one of the tunnel hosts the run was given at dispatch (its agent's `codingProfile.tunnelHosts`, within the proxy's `CODING_TUNNEL_AGENT_HOSTS`). Server-list names match exactly: allowing `example.com` does not allow `sub.example.com`. An agent's `*.example.com` matches any subdomain, but not `example.com` itself.

Fix: use the hostname rather than an address. If every run should reach the host, add that exact name to `CODING_TUNNEL_ALLOWED_HOSTS`; if only one agent's runs should, add it (or a `*.domain` pattern) to that agent's `codingProfile.tunnelHosts`, within the ceiling (see [Per-agent tunnel hosts](../coding-proxy-tunnel.md)). `get_run` shows what a run was given; an agent edit applies from the next run. Allow a shared host (an object store or CDN) only if you accept every tenant on it. The refused name is not written to the audit record.
