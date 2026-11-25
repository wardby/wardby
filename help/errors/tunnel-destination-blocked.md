---
id: errors/tunnel-destination-blocked
title: Tunnel destination blocked (tunnel_destination_blocked)
summary: The allowed host resolves to an address the proxy will not connect to.
audience: operator
tags: [error, coding-agents, proxy, tunnel, tunnel_destination_blocked]
appliesTo: ">=0.10.1"
---

# tunnel_destination_blocked

`tunnel_destination_blocked` (HTTP 403) is an answer from the coding proxy's [CONNECT tunnel](../coding-proxy-tunnel.md). The body is fixed JSON and never repeats the host, the token or any header value.

The host is on the allowlist, but at least one address its name resolves to is private, loopback, link-local, reserved or a cloud metadata address. The proxy refuses the whole name rather than choosing a safe address, and connects only to the address it checked.

Fix: this is usually a split-horizon or internal DNS answer for a public name. Remove the host from the allowlist, or fix its DNS so it resolves only to public addresses.
