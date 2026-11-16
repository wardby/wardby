---
id: errors/substrate-capacity
title: No Substrate worker has room (substrate_capacity)
summary: The experimental Substrate launcher found no worker with room for a run's two actors; the run waits in the queue and is retried.
audience: operator
tags: [error, substrate, substrate_capacity, capacity, job launcher, coding-agents, queue]
appliesTo: ">=0.9.15"
---

# No Substrate worker has room

`substrate_capacity` means the Substrate API refused to place a run's actors
because no worker in the WorkerPool has enough free CPU and memory for both. It
is not a failure: the launcher removes what it created and the run goes back to
the queue, like a Kubernetes run that fits no quota. It stays `pending` with
`codingQueuedAt` set and is retried later.

A run on a new template waits while its golden snapshot builds; a template that
never becomes ready fails with
[substrate_image_unready](substrate-image-unready.md).

A run still waiting after `CODING_QUEUE_TIMEOUT_SEC` fails with
`coding_queue_timeout`. If that happens often:

1. Add workers to the WorkerPool, or use larger nodes. Each run needs room for
   an agent actor and a tool actor at the sizes its limits ask for.
2. Lower `CODING_MAX_CONCURRENT` so fewer runs compete.
3. If `SUBSTRATE_WORKER_SELECTOR` is set, check that enough workers carry those
   labels: workers that do not match are not counted.

See [Runs that wait for cluster capacity](../troubleshooting/coding-workers.md#runs-that-wait-for-cluster-capacity),
[Run coding agents on Substrate](../job-launcher-substrate.md) and the
[Substrate backend guide](../../docs/substrate-backend.md).
