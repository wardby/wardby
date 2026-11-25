---
id: errors/tunnel-port-not-allowed
title: Tunnel port not allowed (tunnel_port_not_allowed)
summary: The tunnel only connects to port 443.
audience: operator
tags: [error, coding-agents, proxy, tunnel, tunnel_port_not_allowed]
appliesTo: ">=0.10.1"
---

# tunnel_port_not_allowed

`tunnel_port_not_allowed` (HTTP 403) is an answer from the coding proxy's [CONNECT tunnel](../coding-proxy-tunnel.md). The body is fixed JSON and never repeats the host, the token or any header value.

The target host is allowed, but the port is not 443. The tunnel never connects anywhere else.

Fix: reach the service over HTTPS on port 443, or serve it on 443. The port is not configurable.
