---
id: errors/substrate-startup-timeout
title: Substrate actors never reached the coding proxy (substrate_startup_timeout)
summary: A coding run on the experimental Substrate launcher failed because its actors did not contact the coding proxy within SUBSTRATE_STARTUP_TIMEOUT_SEC; check the proxy, its hostname and the egress path.
audience: operator
tags: [error, substrate, substrate_startup_timeout, job launcher, coding-agents, egress, SUBSTRATE_PROXY_HOST]
appliesTo: ">=0.9.15"
---

# Substrate actors never reached the coding proxy

`substrate_startup_timeout` (logged as `job_substrate_startup_timeout`) means
the run's actors were created but the bridges inside them did not reach the
coding proxy within `SUBSTRATE_STARTUP_TIMEOUT_SEC` (300 seconds by default).
The actors are deleted and the run fails.

Look for the proxy's `substrate.diagnostics` warning in the operator log: when a
worker or tool bridge exits early, the proxy records a bounded, redacted tail
of its error output there. Then check, in order:

1. **The proxy is running** and was started with `SUBSTRATE_ATESPACE`,
   `SUBSTRATE_PROXY_HOST`, `SUBSTRATE_ACTOR_JWT_ISSUER` and a blob store. A
   proxy without `SUBSTRATE_ATESPACE` has no Substrate routes.
2. **The hostname matches.** `SUBSTRATE_PROXY_HOST` (and
   `SUBSTRATE_PROXY_PORT`, if set) must be the same on the control plane and the
   proxy, and resolvable from a worker.
3. **Egress and routing.** The router must route that host to the proxy, and
   the egress gateway must be healthy; restart it after a Substrate
   API-server outage.
4. **The credential provider can read the run Secret.** After granting it
   access to `SUBSTRATE_CREDENTIALS_NAMESPACE`, restart it.
5. **Slow image pulls.** If the images are large or the registry is slow,
   raise `SUBSTRATE_STARTUP_TIMEOUT_SEC` (30 to 7200).

See [Run coding agents on Substrate](../job-launcher-substrate.md) and the
[Substrate backend guide](../../docs/substrate-backend.md).
