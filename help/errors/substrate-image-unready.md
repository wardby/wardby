---
id: errors/substrate-image-unready
title: A Substrate run's image never became ready (substrate_image_unready)
summary: A coding run on the experimental Substrate launcher failed because Substrate could not build its template's golden snapshot twice in a row, or the template never became ready; usually a custom image without the Substrate bridge.
audience: operator
tags: [error, substrate, substrate_image_unready, workerImageRef, golden snapshot, job launcher]
appliesTo: ">=0.9.15"
---

# A Substrate run's image never became ready

`substrate_image_unready` means the run's actor template can never start an
actor, so the run fails instead of waiting in the queue. One of these happened:

- Substrate could not build the template's golden snapshot, rebuilt it, and the
  build failed again within `SUBSTRATE_TEMPLATE_RETRY_SEC` (default 600 s); or
- the template never became ready within `SUBSTRATE_TEMPLATE_READY_SEC`
  (default 900 s) while the workers had room for the run. The time counts from
  the first start Substrate refused while the workers had room; time spent
  waiting for capacity does not count.

Wardby uses Substrate's template status to judge ready when Substrate reports
it: a template whose golden snapshot is tagged is ready and never fails this
way, and one still building (a status with no golden-snapshot status or no tag yet) is
not ready. A
template an actor has already started from is always ready and never fails this
way, whatever its status says later. When Substrate reports no such status, a
template counts as ready once an actor from it has started. A failed
golden-snapshot build always counts as a failure.

A broken image's first run is usually refused by Substrate as unavailable when
it starts its actors, before the template's status shows the failed build.
Wardby reads the status again then: a failed build counts as a golden-snapshot
failure. A template still building (no golden-snapshot status or no tag yet), on which no
actor has started, is not counted: the run goes back to the queue without a rebuild, and the failed
build is counted when the run is retried. The run that counts the first failure
goes back to the queue while the template is rebuilt, and the run that counts
the second failure fails with `substrate_image_unready`, not
`substrate_unavailable`.

The control plane logs `substrate_template_unready` (with the template's name,
its role and the reason `golden_failed` or `never_ready`) and, for each failed
build, `substrate_template_golden_failed`. Substrate's own message is not
shown; check the template with Substrate's tooling.

## Causes

Usually a custom image (`codingProfile.workerImageRef`):

- **The image has no Substrate bridge**, or one in the wrong place. Add the
  bridge layer of this release (see
  [build-claude-code-image](../build-claude-code-image.md),
  [build-worker-image](../build-worker-image.md) and
  [Custom images](../../docs/substrate-backend.md#custom-images)).
- **The wrong architecture.** The image must match the Substrate workers'
  (release images are `linux/amd64`).
- **The workers cannot pull it.** Wardby passes no pull credential: a private
  registry needs pull access configured for the Substrate worker nodes.
- **Port 8080 is taken** by something in the image, so the bridge's readiness
  probe fails.

## Recovery

Within the window, runs on the same template fail at once without rebuilding
it. Once `SUBSTRATE_TEMPLATE_RETRY_SEC` has passed, the next run rebuilds the
template once, so fixing something outside the image (such as registry access)
recovers without a new digest. A new image digest always gets a new template.

A run that only waits for room is not this error: see
[substrate_capacity](substrate-capacity.md). Actors that start but never reach
the coding proxy (for example after a slow image pull) fail with
[substrate_startup_timeout](substrate-startup-timeout.md) instead. For other
launchers, see [Troubleshoot coding workers](../troubleshooting/coding-workers.md).

See [Run coding agents on Substrate](../job-launcher-substrate.md) and the
[Substrate backend guide](../../docs/substrate-backend.md#templates-and-snapshots).
