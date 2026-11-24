---
id: errors/intercept-destination-blocked
title: Intercepted destination blocked (intercept_destination_blocked)
summary: The intercepted host no longer resolves only to public addresses.
audience: operator
tags: [error, coding-agents, proxy, tunnel, intercept, intercept_destination_blocked]
appliesTo: ">=0.10.1"
---

# intercept_destination_blocked

`intercept_destination_blocked` (HTTP 403) is an answer from the coding proxy's TLS interception for a credentialed host, sent inside the run's TLS (see [CONNECT tunnel](../coding-proxy-tunnel.md#tls-interception-for-a-credentialed-host)). The body is fixed JSON and never repeats a header, a path, the host or the credential.

The host resolved to a private, loopback, link-local or cloud metadata address when the request was made, so the proxy refused to connect and attached no credential. The check runs on every request, not only when the tunnel opens.

Fix: check the host's DNS records. If you control the name and it should point at a private address, it does not belong behind a public-address check; do not intercept it through this tunnel.
