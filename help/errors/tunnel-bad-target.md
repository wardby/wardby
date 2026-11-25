---
id: errors/tunnel-bad-target
title: Tunnel target not host:port (tunnel_bad_target)
summary: The CONNECT target could not be read as host and port.
audience: operator
tags: [error, coding-agents, proxy, tunnel, tunnel_bad_target]
appliesTo: ">=0.10.1"
---

# tunnel_bad_target

`tunnel_bad_target` (HTTP 400) is an answer from the coding proxy's [CONNECT tunnel](../coding-proxy-tunnel.md). The body is fixed JSON and never repeats the host, the token or any header value.

The request line did not name a `host:port` the proxy can read: no port, a port that is not digits, an empty or malformed host, or a target over 300 characters.

Fix: use a client that sends a standard `CONNECT host:443`. This usually means something other than an HTTPS client, or a bad URL in the client's configuration.
