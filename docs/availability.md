# Availability

This guide covers what each Wardby workload on Kubernetes does when a pod or
node goes away, how long recovery takes, and the Helm values that control it:
replica counts, PodDisruptionBudgets and topology spread. It applies to the
Helm chart (see [Install with Helm](install-helm.md)) with its default
`EXECUTOR=dbos`.

## Components

| Workload                | Chart default | More than one copy | When its pod goes away                                                       |
| ----------------------- | ------------- | ------------------ | ---------------------------------------------------------------------------- |
| `wardby-control-plane`  | 1             | Supported          | MCP, webhooks and scheduling stop unless another copy is running             |
| `wardby-coding-proxy`   | 1             | Not supported yet  | Model and package requests of coding runs fail until the replacement serves  |
| `wardby-native-gateway` | 2             | Supported          | Sandbox runs use the other replica                                           |
| `wardby-headroom`       | 1             | n/a                | Nothing; it only holds spare capacity and is the first pod evicted           |
| `wardby-migrate` (Job)  | n/a           | n/a                | Runs once per install or upgrade; a failure fails the release, nothing stops |

A single copy of the control plane is not highly available: draining its
node, upgrading the node, or losing it stops MCP, webhooks and schedules until
a replacement pod is ready. Run two copies (see
[Running two control-plane copies](#running-two-control-plane-copies)) to keep
them up through a node drain.

### Why the control plane can run more than one copy

Every coordinating piece of the control plane keeps its state in PostgreSQL:

- **Scheduler.** Copies elect one ticker through a lease row that expires
  after 30 seconds (stamped with the database's clock, so a copy whose own
  clock is off cannot shorten or stretch it), and claiming a due run takes a
  row lock, so a schedule fires once no matter how many copies run. A copy that
  shuts down gracefully deletes its lease row, so another copy takes over at
  its next lease check (every 10 seconds) instead of waiting for the expiry.
- **Reconciler.** Every copy runs it. It changes a run's status only with a
  conditional update, so two copies reconciling the same run is a no-op, not a
  race.
- **Deferred starts, stops and reviews.** The scheduler leader starts runs
  that the native sandbox gateway dispatched, stops runs it asked to stop, and
  starts reviews that waited for CI or for a delegating run. Each of these acts
  first and clears its marker after: a start or review is claimed with a
  timestamp that another pass takes over once it is 2 minutes (starts) or 5
  minutes (reviews) old, and a stop stays requested until the executor has
  stopped the run. A leader that dies in between therefore loses nothing: the
  next leader does the work, and starting a run that is already started
  attaches to it. A stop request is never dropped.
- **Durable executor.** Each process gets its own executor id. A run executes
  on the copy that started it and records each completed step in PostgreSQL;
  when its heartbeat stops, any copy adopts it and resumes from the last
  completed step. Leave `DBOS_EXECUTOR_ID` unset so each copy gets a unique
  one (see [Durable executor](security-deployment.md#durable-executor)).
- **Coding runs.** The `CODING_MAX_CONCURRENT` cap is enforced in PostgreSQL,
  so adding copies never raises it, and any copy can observe, collect or stop
  a run pod, and push its changes even though it did not launch it (see
  [Coding-worker isolation](coding-worker-isolation.md) and
  [Pod or node loss](#failures-and-recovery) below).
- **MCP.** Requests carry their own state, so any copy can serve any request
  and the load balancer needs no session affinity. Browser secret entry needs
  the same `SECRET_APP_KEY` (or `REQUEST_STATE_KEY`) on every copy, which the
  chart gives them.

### Why the coding proxy runs one copy

The proxy's spend ledger is in PostgreSQL, and so is the package registry's
per-run state: the files and bytes a run has been served, the downloads in
flight, the lockfile plans (how many, and the one running now) and which
ecosystems fell back to dependency-graph walks (see
[Installing packages in coding runs](coding-packages.md)). A request for a
run's packages therefore gets the same answer from any proxy pod, the per-run
limits hold in total rather than per pod, and an install carries on when the
proxy restarts partway through it. A pod that dies mid-download or mid-plan
stops counting against the run once its lease lapses: a download's lease is
`REGISTRY_IDLE_TIMEOUT_MS` plus a minute, a plan's is its time bounds plus a
minute.

Three things stay per pod, because losing them costs only time: the package
metadata cache, the dependency-graph memo, and the caps on how many graph
walks and lockfile plans run at once across all runs.

Running more than one proxy is otherwise not supported yet. Keep
`codingProxy.replicas` at 1.

## Failures and recovery

**Node drain or upgrade (voluntary).** The evicted control-plane pod gets a
graceful shutdown: it keeps serving for `controlPlane.preStopSleepSeconds` (30)
while the load balancer drains it, stops scheduling and reconciling (a pass
already running is given up to two minutes to finish, so it cannot start work
after the drain begins), then waits up to `SHUTDOWN_DRAIN_SECONDS` (600) for
its in-flight runs before exiting,
within `controlPlane.terminationGracePeriodSeconds` (720). A run still going
when it exits is adopted like a run on a lost pod.

The drain waits for native runs only. A coding run's pod is not stopped,
removed or failed by the copy that is shutting down: the copy stops watching
it, its workspace is left as it is, and another copy adopts the run through its
next reconciler pass (see the recovery below). Once the copy has begun to shut
down it refuses to start, stop or recover runs, so a pass that was already in
flight cannot relaunch the durable executor in a process that is about to exit,
and a run it refused stays as it was for the next copy to start. Right after
the scheduler and reconciler stop, the copy releases the scheduler lease: with
a second copy running, schedules resume within one lease check (about 10
seconds) rather than 30.

The evicted coding-proxy pod keeps accepting requests for
`codingProxy.preStopSleepSeconds` (10) while the Service stops routing to it,
then stops listening and finishes the model requests and package downloads in
flight, within `codingProxy.terminationGracePeriodSeconds` (600). Until its
replacement is ready, new requests from coding runs fail and the workers
retry them. A model request still running when the grace period ends is cut
off: its budget hold is settled once its lease runs out (see
[A model request whose proxy stops mid-stream](#a-model-request-whose-proxy-stops-mid-stream)),
and the worker's retry of it takes over as a new attempt once that lease has
run out. Raise the grace period if your model requests can run longer.

**Pod or node loss (involuntary).** A run's heartbeat stops. After the
45-second heartbeat timeout, the next reconciler pass (every 15 seconds) on a
running copy adopts it. A native run resumes from its last completed step, and
the step that was in flight runs again. A coding run's pod keeps running and
the adopting copy collects its result, and keeps watching it as the launching
copy did: a run with an overrun limit is still topped up from its budget group's
room. A run that cannot be resumed is marked `lost`.

A native run that was created but never started (the copy died after
committing the run, for example a scheduled fire) has run no step. The
reconciler starts it instead of marking it `lost`, up to three times per run;
only a run that still does not start is marked `lost` (`errors/run-lost`). A
scheduled run in this state runs once, not zero or two times.

A coding run's git checkout lives under `VCS_WORK_ROOT` on the disk of the copy
that launched it, so the adopting copy does not have it. When it has changes to
push (a finished run, or one stopped at its budget with `keepStoppedChanges`), it
clones the repository again and pins the clone to what the launching copy
recorded with the run's job handle: the commit the run started from and, for a
follow-up run that merged its pull request's target branch, the target commit it
merged. The agent's result is then copied in and pushed exactly as the launching
copy would have, onto the original base even if the branch has moved since. A
rebuild that cannot reproduce that exact base (a force-push removed the commit,
or the repository no longer lists it) pushes nothing and fails the run with
`vcs_rebuild_base_unavailable`; see the help article
`errors/vcs-rebuild-base-unavailable`. A run launched before the base was
recorded cannot be rebuilt and ends `coding_workspace_lost` (`errors/coding-workspace-lost`).
No shared volume is needed for `VCS_WORK_ROOT`.

**Work that follows a run's end.** The chores that follow a run's final status
are queued in PostgreSQL in the same transaction that writes the status, so a
pod that dies right after the write cannot lose them. For a run marked `lost`
they are stopping its still-running child runs, filing its self-defect and
emitting its workflow events. For a coding run they are capturing its session
transcript and then removing its job (the pod, network policy and capability
Secret), posting the final status on its pull request, running the no-change
re-review, and releasing reviews that waited for it. The copy that ended the run
does the coding-run chores right away and marks them done; if that copy died
first, the scheduler leader runs them after about a minute. A failing chore is
retried with exponential backoff (at most 10 minutes between tries), and every
chore is safe to run again. Capture always comes before removal: a pod that
cannot be read is retried up to five times, then the transcript is recorded as
`not_captured` and the job is removed anyway; a job that is already gone is
recorded as `not_captured` without retries. Because the leader has no copy of the
run's checkout or its in-memory summary, a final pull request status it posts
for a run another copy launched is built from what is stored on the run, so it
can omit the agent's summary line. See [Observability](observability.md) for the
backlog metrics.

### A model request whose proxy stops mid-stream

A model request holds part of its run's budget from the moment it is reserved
until it settles. The proxy process that reserved it keeps a lease on the
request, renewed every `CODING_PROXY_HEARTBEAT_SECONDS` (10) for
`CODING_PROXY_LEASE_SECONDS` (30). When that process stops (a node loss, an
out-of-memory kill, or a grace period that ends first), the lease stops being
renewed. Once it has run out, any running proxy settles the request as
uncertain at an estimated cost, checked every `CODING_PROXY_SWEEP_SECONDS`
(15). The hold stops counting against the run's budget and the estimate counts
as spend, so a later request of the run is not refused for a reservation
nothing will settle.

- With the default settings the hold is released up to 45 seconds after the
  proxy stops, and only once a proxy is running again.
- The estimate comes from the conversation's previous reply, the size of the
  request body or the model's median reply, and never exceeds the request's
  worst case.
- A proxy that was only stalled, not stopped, finds out. Each heartbeat checks
  which of its requests were renewed; one that was settled by another proxy or
  taken over is no longer its own, so it aborts the upstream call and stops
  relaying it, within one heartbeat of the stall ending. The request stays
  settled at its estimate.
- A stopped run reaches the proxy the same way. Stopping a run cancels its
  proxy session in the database, from whichever control plane copy handles the
  stop; the proxy that holds the model stream is not told directly. Its next
  heartbeat sees the session is cancelled, aborts the upstream call and stops
  relaying, so a stopped run's model request stops generating (and billing)
  within one heartbeat (10 seconds by default). The request settles as uncertain
  at an estimate from what was received, never above its worst case; the run's
  next model request is refused as cancelled. A request that finished before
  the heartbeat is settled at its real cost.
- A request reserved before leases existed carries none and is never swept.
- The worker's retry of the same request is a new attempt, not a duplicate,
  once the original's lease has run out (see
  [A retry after the proxy stopped](#a-retry-after-the-proxy-stopped)).

The lease must be more than twice the heartbeat, or the proxy refuses to
start. A longer lease means fewer settlements of a slow but live request and a
longer wait to release a stopped proxy's hold. Metrics:
[Monitor Wardby](observability.md#request-leases).

### A retry after the proxy stopped

The worker's client retries a model request that failed because the proxy
stopped, resending the same body. The proxy recognises the retry by its request
key (the `Idempotency-Key` header if the client sends one, otherwise a hash of
the body) and answers by the state of the earlier request:

| The earlier request                                              | The retry gets                                                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Reserved, lease still running                                    | `503 wardby_request_in_progress`, with `Retry-After` set to the lease's remaining time plus one second. Nothing is sent upstream |
| Reserved with its lease run out, or already settled by the sweep | A new attempt: the earlier request is settled at its estimate, and the retry is reserved with its own hold and sent upstream     |
| Attempts used up (three per request key)                         | `422 wardby_request_attempts_exhausted`, which clients do not retry                                                              |
| Completed                                                        | `409 duplicate_completed`: a finished reply is never sent twice                                                                  |
| Uncertain after a stream broke under a running proxy             | `409 duplicate_uncertain`                                                                                                        |
| Reserved before leases existed (no lease)                        | `409 duplicate_reserved`: it cannot be told from a live request                                                                  |
| Same request key, different body                                 | `409 idempotency_conflict`                                                                                                       |

A takeover settles the earlier request and reserves the new one in one
database transaction under the run's lock, so two retries arriving together
create one new attempt; the other is told it is in progress. The audit log
records `request.taken_over` with the earlier and the new request id and the
attempt number. Both attempts count against the run's budget: the earlier one
at its estimate and the new one at its hold. If no estimate can be made, the
earlier request keeps its full hold and the retry is refused with
`409 duplicate_uncertain`.

A takeover can bill the model provider twice for one turn, since the first
attempt may have been billed before its proxy stopped. The attempt limit bounds
that. The proxy never sends a second upstream request while the earlier
attempt's lease is running. Keep `CODING_PROXY_LEASE_SECONDS` short enough that
`Retry-After` (about a lease long at most) stays within what your workers' client
waits for. See `errors/request-in-progress`, `errors/request-attempts-exhausted`
and `errors/duplicate-request` for the operator-facing explanations.

Expected recovery:

| What                         | One control-plane copy                                     | Two copies                                                                                             |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| MCP and webhooks             | Down until the replacement pod is ready                    | Served by the other copy; requests in flight to the lost copy fail                                     |
| Runs on the lost copy        | Adopted by the replacement's reconciler once it is running | Adopted by the other copy within about a minute (45 s + up to 15 s)                                    |
| Schedules                    | Paused until the replacement is ready                      | The other copy takes the lease within about 10 seconds of a drain, or within 30 seconds of a lost copy |
| Coding proxy (always 1 copy) | Down until its replacement is ready                        | Same                                                                                                   |

How long "until the replacement is ready" takes depends on your cluster: pod
scheduling, image pull, the Cloud SQL Auth Proxy connecting, and server start.
It takes several minutes longer when the cluster must add a node first. The
`wardby-control-plane` PriorityClass lets a replacement preempt coding-run and
headroom pods rather than wait for a node.

## PodDisruptionBudgets

A PodDisruptionBudget limits how many of a workload's pods a voluntary
disruption (`kubectl drain`, a node upgrade, a cluster-autoscaler scale-down)
may evict at once. It does not protect against a node failing.

| Workload       | Value                               | Default                 |
| -------------- | ----------------------------------- | ----------------------- |
| Control plane  | `controlPlane.podDisruptionBudget`  | on, `maxUnavailable: 1` |
| Native gateway | `nativeGateway.podDisruptionBudget` | on, `maxUnavailable: 1` |
| Coding proxy   | `codingProxy.podDisruptionBudget`   | off                     |

With one replica, `maxUnavailable: 1` still allows the only pod to be evicted;
the budget starts to protect the control plane once it runs two copies. Set
`minAvailable` instead of `maxUnavailable` to require a number of pods to stay
up. Every budget the chart renders sets
`unhealthyPodEvictionPolicy: AlwaysAllow`, so a pod that is not ready never
holds up a drain.

The coding proxy has no budget because a budget that allows no disruptions on
a one-pod workload does not keep it up. It makes `kubectl drain` wait
indefinitely, and managed node upgrades honour a budget only for a limited
time (one hour on GKE) before they evict the pod anyway. Instead, an evicted
proxy finishes its requests in flight before it exits (see
[Failures and recovery](#failures-and-recovery)).

## Running two control-plane copies

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

- Leave room for the second copy: one more `controlPlane.resources` request
  (1 CPU and 2 GiB by default) plus its Cloud SQL Auth Proxy sidecar, and
  database connections for its own pool.
- Spread the copies across nodes. Two copies on one node both stop when that
  node fails; the budget only keeps a drain from evicting both at once.
- Keep `DBOS_EXECUTOR_ID` unset and give every copy the same environment. The
  chart does both.
- A run executes on the copy that started it: scheduled runs on the copy
  holding the scheduler lease, runs started by a webhook or over MCP on the
  copy that took the request.
- Changing `replicas` alone adds a pod; changing `topologySpreadConstraints`
  changes the pod template and restarts the existing copy, which ends its
  in-flight runs as in a drain.

The native gateway is stateless and already runs two replicas. Spread it the
same way with `nativeGateway.topologySpreadConstraints`.

## Probes

Each workload has a readiness probe, which takes a pod out of its Service
while it fails:

| Workload       | Readiness probe                                                     |
| -------------- | ------------------------------------------------------------------- |
| Control plane  | `GET /.well-known/oauth-protected-resource` with the canonical Host |
| Coding proxy   | TCP on the proxy port (8787)                                        |
| Native gateway | `GET /healthz`, which also checks the database                      |

There are no liveness probes, by design:

- **Control plane.** It stops serving HTTP at the start of its graceful
  shutdown and then waits up to ten minutes for in-flight runs, so a liveness
  probe would fail during every drain and cut it short. A copy that hangs stops
  beating its runs' heartbeats, and another copy adopts them.
- **Coding proxy.** Its serving port has no unauthenticated health endpoint,
  and a TCP check passes even when the process is hung. A restart fails every
  model request in flight.
- **Native gateway.** `/healthz` checks the database, so a liveness probe on it
  would restart every replica during a database outage, which restarting does
  not fix.

There are no startup probes either: a startup probe only holds off liveness
and readiness checks, and readiness already keeps a starting pod out of its
Service. The Cloud SQL Auth Proxy sidecar has a startup probe so the workload
container starts after the database connection is up.

Watch for a pod that stays unready: alert when a Deployment's available
replicas stay below its desired count.
