---
id: errors/tunnel-connect-only
title: Tunnel accepts CONNECT only (tunnel_connect_only)
summary: A request other than CONNECT reached the tunnel port, including a plain http:// request.
audience: operator
tags: [error, coding-agents, proxy, tunnel, tunnel_connect_only]
appliesTo: ">=0.10.1"
---

# tunnel_connect_only

`tunnel_connect_only` (HTTP 405) is an answer from the coding proxy's [CONNECT tunnel](../coding-proxy-tunnel.md). The body is fixed JSON and never repeats the host, the token or any header value.

The tunnel port serves nothing but `CONNECT`. A plain `http://` request sent through `HTTP_PROXY` is answered `405` with `Allow: CONNECT` and is never forwarded, because a credential is never attached to a plaintext request.

Fix: use an `https://` URL. A client that sends registry or model requests to the tunnel port should go to the proxy's main port instead, with the proxy's own address in `NO_PROXY`.
