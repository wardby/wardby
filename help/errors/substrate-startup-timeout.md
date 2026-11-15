---
id: errors/substrate-startup-timeout
title: Substrate actors never reached the coding proxy (substrate_startup_timeout)
summary: A coding run on the experimental Substrate launcher failed because its actors did not contact the coding proxy within SUBSTRATE_STARTUP_TIMEOUT_SEC; check the proxy, its hostname and the egress path.
audience: operator
tags: [error, substrate, substrate_startup_timeout, egress, SUBSTRATE_PROXY_HOST, SUBSTRATE_ACTOR_JWT_ISSUER]
appliesTo: ">=0.9.15"
---

# Substrate actors never reached the coding proxy

`substrate_startup_timeout` (logged as `job_substrate_startup_timeout`) means
the run's actors were created but the bridges inside them did not reach the
coding proxy within `SUBSTRATE_STARTUP_TIMEOUT_SEC` (300 seconds by default).
The actors are deleted and the run fails.

Look for the proxy's `substrate.diagnostics` warning in the operator log: when
the worker fails, the proxy records a bounded tail of the agent bridge's error
output there, redacted by exact value. The tool bridge sends none; look at the
proxy's route log for the run's tool requests (`tool-setup`, `seed`, `events`)
and their status. Then check, in order:

1. **The proxy is running** and was started with `SUBSTRATE_ATESPACE`,
   `SUBSTRATE_PROXY_HOST`, `SUBSTRATE_ACTOR_JWT_ISSUER` and a blob store. A
   proxy without `SUBSTRATE_ATESPACE` has no Substrate routes.
2. **The hostname matches.** `SUBSTRATE_PROXY_HOST` (and
   `SUBSTRATE_PROXY_PORT`, if set) must be the same on the control plane and the
   proxy, and resolvable from a worker. A proxy without the same port answers
   every actor request with `invalid_host`.
3. **Tool requests answer 401.** The proxy verifies the tool actor's token
   against `SUBSTRATE_ACTOR_JWT_ISSUER`, which must be Substrate's own identity
   provider (for example `https://idp.ate-system.svc` in a default install),
   not the cluster's service-account issuer. The proxy fetches that issuer's
   signing keys over TLS signed by Substrate's internal CA, so it must trust
   that CA: set `NODE_EXTRA_CA_CERTS` on the proxy to the CA bundle from the
   `servicedns.podcert.ate.dev` ClusterTrustBundle. Without it, every tool
   request is refused and the tool side cannot even report the failure.
4. **Egress and routing.** The router must route that host to the proxy, and
   the egress gateway must be healthy; restart it after a Substrate
   API-server outage.
5. **The credential provider can read the run Secret.** After granting it
   access to `SUBSTRATE_CREDENTIALS_NAMESPACE`, restart it.
6. **Slow image pulls.** If the images are large or the registry is slow,
   raise `SUBSTRATE_STARTUP_TIMEOUT_SEC` (30 to 7200).

See [Run coding agents on Substrate](../job-launcher-substrate.md) and the
[Substrate backend guide](../../docs/substrate-backend.md).
