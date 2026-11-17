---
id: errors/substrate-feature-unsupported
title: The Substrate launcher does not support this run (substrate_feature_unsupported)
summary: A coding run's services cannot start on the experimental Substrate launcher (an entry without a start command, a reserved data path, or too large); dispatch normally refuses these first.
audience: operator
tags: [error, substrate, substrate_feature_unsupported, job launcher, coding-agents, services, startCommand]
appliesTo: ">=0.9.15"
---

# The Substrate launcher does not support this run

`substrate_feature_unsupported` means the run asked for something the
experimental Substrate launcher cannot do. The run fails at launch, before any
actor is created. The control plane log names the feature (`services`).

| Trigger                                                                                                                                                    | Feature    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A service whose catalog entry has no `startCommand`, a `dataPath` that overlaps `/run/wardby-svc`, or a start script over 16 KiB (64 KiB for all services) | `services` |

Coding services themselves are supported on Substrate from release 0.10.1.
Dispatch checks the same things first and refuses such a run with
[`service_launcher_unsupported`](service-launcher-unsupported.md), so this
launcher's check is a backstop: this error appears only when a run reaches the
launcher without that dispatch check.

What to do: fix the catalog entry as
[`service_launcher_unsupported`](service-launcher-unsupported.md) describes,
then run it again.

Older runs may show `substrate_feature_unsupported:workerImage`: custom images
are supported now; run it again. Older runs that failed this way for any
service at all can also be run again.

See [Run coding agents on Substrate](../job-launcher-substrate.md), the
[Substrate backend guide](../../docs/substrate-backend.md#what-is-not-supported)
and [Coding services](../coding-services.md#substrate-launcher).
