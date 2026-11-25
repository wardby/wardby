---
id: errors/tunnel-auth-required
title: Tunnel credential missing or wrong (tunnel_auth_required)
summary: The CONNECT request carried no usable tunnel token.
audience: operator
tags: [error, coding-agents, proxy, tunnel, tunnel_auth_required]
appliesTo: ">=0.10.1"
---

# tunnel_auth_required

`tunnel_auth_required` (HTTP 407) is an answer from the coding proxy's [CONNECT tunnel](../coding-proxy-tunnel.md). The body is fixed JSON and never repeats the host, the token or any header value.

The request had no `Proxy-Authorization` header, the header was not Basic, the password was empty, or no session has that token. The response includes a `Proxy-Authenticate` challenge.

Fix: give the client a proxy URL that carries the run's tunnel token as the password, for example `http://run:<token>@<proxy-host>:<tunnel-port>`, URL-encoding any special characters. The token is separate from the run's model capability and registry token; those are not accepted here. The check comes first, so this code says nothing about whether the host would have been allowed.
