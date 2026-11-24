---
id: errors/intercept-upstream-failed
title: Intercepted upstream failed (intercept_upstream_failed)
summary: The proxy could not complete the request to the intercepted host.
audience: operator
tags: [error, coding-agents, proxy, tunnel, intercept, intercept_upstream_failed]
appliesTo: ">=0.10.1"
---

# intercept_upstream_failed

`intercept_upstream_failed` (HTTP 502) is an answer from the coding proxy's TLS interception for a credentialed host, sent inside the run's TLS (see [CONNECT tunnel](../coding-proxy-tunnel.md#tls-interception-for-a-credentialed-host)). The body is fixed JSON and never repeats a header, a path, the host or the credential.

The proxy could not connect to the host, could not verify its certificate, or the connection ended before an answer. The host's certificate is verified normally; it is not skipped. No detail is returned to the run.

For a host with a `gcp` rule, it is also the answer when the proxy could not get an access token for its own Google service account: the proxy logs `intercept.credential_unavailable` with a fixed reason (`metadata_unreachable`, `metadata_http_<status>` or `metadata_bad_response`), and the next request tries again.

Fix: check that the host is reachable from the proxy and that its certificate is valid and chains to a public authority. For a `gcp` rule, also check that the proxy's pod can reach the metadata server and runs as a Kubernetes ServiceAccount bound to a Google service account (Workload Identity). The proxy's log records the refusal code only, never the credential or the request.
