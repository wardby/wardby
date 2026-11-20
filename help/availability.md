---
id: availability
title: Availability and PodDisruptionBudgets
summary: Which Wardby workloads run as a single instance, what happens when a pod or node is lost or drained, recovery times, PodDisruptionBudgets, and running two control-plane copies for high availability.
audience: operator
tags:
  [
    availability,
    high-availability,
    ha,
    single-instance,
    replicas,
    PodDisruptionBudget,
    pdb,
    node-drain,
    node-upgrade,
    recovery,
    rto,
    liveness-probe,
    readiness-probe,
    topologySpreadConstraints,
    helm,
    kubernetes,
  ]
appliesTo: ">=0.10.2"
---

# Availability and PodDisruptionBudgets

The Helm chart runs **one control-plane copy** by default, so it is not highly
available: a node drain, node upgrade or node failure stops MCP, webhooks and
schedules until a replacement pod is ready. The coding proxy always runs one
copy. The native gateway runs two.

Runs survive the loss of a control-plane pod. A pod that is drained finishes
its in-flight native runs for up to ten minutes before it exits. It leaves its
coding runs' pods running (it neither stops nor fails them) so another copy
adopts them, and it releases the scheduler lease so a second copy takes over
schedules within about 10 seconds instead of waiting up to 30. When a pod dies, its
runs stop heartbeating, and after 45 seconds any running copy adopts them: a
native run resumes from its last completed step, and a coding run's pod keeps
running and its result is collected. The adopting copy also keeps topping up a
coding run that has an overrun limit, as the launching copy would have. It has no git checkout of
the run, so it re-clones at the base commit recorded at launch and pushes the
changes as the original copy would have; if that base cannot be reproduced the
run fails without pushing (`errors/vcs-rebuild-base-unavailable`).

**Work after a run ends is not lost with the pod.** What follows a run's final
status (stopping child runs of a `lost` run, its self-defect and events; for a
coding run, the transcript capture, removing its job, the pull request status
and the re-review) is queued with the status in PostgreSQL. The copy that ended
the run does it at once; if that copy died, the scheduler leader does it after
about a minute and retries failures with backoff. A transcript is always
captured before its job is removed. Watch `wardby_run_follow_ups_pending` and
`wardby_run_follow_up_oldest_age_seconds`.

A run that was created but never started when its copy died (a scheduled fire,
for example) is started again by the next reconciler pass rather than marked
`lost`, and a start, stop or review the scheduler leader had claimed is done by
the next leader (`errors/run-lost`).

**Run two control-plane copies** to keep MCP, webhooks and schedules up through
a drain. Every coordinating piece (scheduler lease, reconciler,
run executor, coding concurrency cap) keeps its state in PostgreSQL:

```yaml
controlPlane:
  replicas: 2
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          app.kubernetes.io/name: wardby-control-plane
```

**PodDisruptionBudgets.** The chart gives the control plane and the native
gateway a budget of `maxUnavailable: 1` (`<workload>.podDisruptionBudget`), so
a drain evicts one pod at a time. At one replica the budget still lets the only
pod go. The coding proxy has none by default: a budget that blocks its only pod
makes `kubectl drain` wait forever, and managed node upgrades evict it anyway
after a timeout. Instead, an evicted proxy finishes its model requests in flight
for up to `codingProxy.terminationGracePeriodSeconds` (600) before it exits. A
proxy pod that dies outright cuts the agent turns streaming through it; the
budget hold of each request it was relaying is settled at an estimate about 45
seconds later by a running proxy, and the worker's retry takes over as a new
attempt once that lease has run out (see
`troubleshooting/stopped-proxy-holds`). A proxy that only stalled long enough to
lose its leases aborts those requests at its next heartbeat instead of billing
for them.

**Probes.** Every workload has a readiness probe. There are no liveness probes,
by design: the control plane stops serving HTTP while it drains runs at
shutdown, the proxy has no health endpoint a hung process would fail, and the
gateway's `/healthz` checks the database.

Full guide, with recovery times per failure:
[`docs/availability.md`](../docs/availability.md).

Related: [Install Wardby with Helm](install-helm.md),
[Deploy Wardby on GKE Autopilot](deploy-gke.md),
[Low-power mode](low-power-mode.md).
