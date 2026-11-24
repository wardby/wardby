---
id: errors/intercept-bad-request
title: Intercepted request refused (intercept_bad_request)
summary: An intercepted request named another host, used an absolute-form target, or asked to upgrade the connection.
audience: operator
tags: [error, coding-agents, proxy, tunnel, intercept, intercept_bad_request]
appliesTo: ">=0.10.1"
---

# intercept_bad_request

`intercept_bad_request` (HTTP 400) is an answer from the coding proxy's TLS interception for a credentialed host, sent inside the run's TLS (see [CONNECT tunnel](../coding-proxy-tunnel.md#tls-interception-for-a-credentialed-host)). The body is fixed JSON and never repeats a header, a path, the host or the credential.

The request's `Host` header is not the host the run tunnelled to, its target is not a plain path (it is an absolute URL, for example), or it asks to upgrade the connection (a WebSocket, for example). Only HTTP/1.1 requests for that one host are served, and nothing was sent upstream or given a credential.

Fix: send the request to the host the tunnel was opened for, with that host in `Host` and a path as the target. A client that reuses one proxy connection for several hosts must open a separate tunnel for each.
