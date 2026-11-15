---
id: errors/substrate-unavailable
title: The Substrate API is unavailable (substrate_unavailable)
summary: A coding run on the experimental Substrate launcher failed because a call to the Substrate API did not succeed; check the API URL, token audience and TLS settings.
audience: operator
tags: [error, substrate, substrate_unavailable, job launcher, coding-agents, gVisor]
appliesTo: ">=0.9.15"
---

# The Substrate API is unavailable

`substrate_unavailable` means a call from the control plane to the Substrate
Control API failed: the API was unreachable, rejected the request, or answered
with something other than success or a known outcome. The run's persisted error
is only a diagnostic id; the control plane log has the reason, with the name of
the failed call and never a token or capability.

1. Check that `SUBSTRATE_API_URL` is reachable from the control plane and that
   the Substrate API server is running.
2. Check the token in `SUBSTRATE_TOKEN_FILE`: it must be a Kubernetes
   ServiceAccount token created with the audience `api.ate-system.svc`, and it
   must not have expired.
3. For a private CA or a certificate name that differs from the URL host, set
   `SUBSTRATE_CA_FILE` and `SUBSTRATE_SERVER_NAME`.
4. Confirm the atespace in `SUBSTRATE_ATESPACE` exists and the token's service
   account may use it.
5. After a Substrate API-server outage, restart the egress gateway: it can stay
   unable to apply egress policies until restarted.

Runs that failed this way did no work; run them again once the API answers. See
[Run coding agents on Substrate](../job-launcher-substrate.md) and the
[Substrate backend guide](../../docs/substrate-backend.md).
