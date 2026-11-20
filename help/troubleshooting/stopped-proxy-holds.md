---
id: troubleshooting/stopped-proxy-holds
title: Troubleshoot budget holds left by a stopped proxy
summary: What happens to a model request when the coding proxy stops mid-request, how its budget hold is settled, and the lease settings and metrics that show it.
audience: operator
tags: [budgets, coding-proxy, reservations, lease, lease_expired, reserved, uncertain, orphaned, takeover, oom]
appliesTo: ">=0.10.2"
---

# Troubleshoot budget holds left by a stopped proxy

Every model request of a coding run holds part of the run's budget from the
moment the coding proxy reserves it until the reply settles it. If the proxy
process stops while a request is in flight (a node loss, an out-of-memory
kill, or a shutdown whose grace period ends first), nothing in that process
settles the request.

## How Wardby settles it

The proxy that reserves a request keeps a **lease** on it and renews the lease
every `CODING_PROXY_HEARTBEAT_SECONDS` (default 10) for
`CODING_PROXY_LEASE_SECONDS` (default 30). When the process stops, the lease
stops being renewed. Once it has run out, any running proxy settles the request
as _uncertain_ at an estimated cost, checking every
`CODING_PROXY_SWEEP_SECONDS` (default 15). The estimate comes from the
conversation's previous reply, the size of the request body, or the model's
median reply, and never exceeds the request's worst case.

The hold then stops counting against the run's budget and the estimate counts
as spend, so a later request of the same run is not refused with
`wardby_budget_exhausted` for a reservation nothing will settle. With the
default settings this takes up to 45 seconds after the proxy stops, and only
once a proxy is running again.

- If the original process was only stalled and finishes the request later, the
  request is corrected to its real cost.
- A request reserved before the upgrade that added leases has no lease and is
  never swept.
- Wardby does not resume the stopped request. The worker's retry of it is a new
  attempt (see below), so the agent's turn recovers instead of failing.

## What the worker's retry gets

- **Before the lease has run out:** `503 wardby_request_in_progress` with a
  `Retry-After` header just past the lease's end. Nothing is sent upstream. The
  client waits and retries. See `errors/request-in-progress`.
- **After the lease has run out:** the stopped request is settled at its
  estimate and the retry is reserved as attempt 2, with its own hold, and sent
  upstream. The audit log records `request.taken_over` with both request ids.
- **After three attempts:** `422 wardby_request_attempts_exhausted`. See
  `errors/request-attempts-exhausted`.
- A request that completed, one whose stream broke under a running proxy, one
  reserved before leases existed, and the same key with a different body are
  never taken over. See `errors/duplicate-request`.

A takeover can bill the model provider twice for one turn, because the first
attempt may have been billed before its proxy stopped. Both attempts count
against the run's budget.

## Settings

| Setting                          | Default | Rule                                                          |
| -------------------------------- | ------- | ------------------------------------------------------------- |
| `CODING_PROXY_LEASE_SECONDS`     | 30      | More than twice the heartbeat, or the proxy refuses to start. |
| `CODING_PROXY_HEARTBEAT_SECONDS` | 10      | Positive integer.                                             |
| `CODING_PROXY_SWEEP_SECONDS`     | 15      | Positive integer.                                             |

A longer lease means fewer false settlements of a request whose process is slow
to renew, and a longer wait before a stopped proxy's hold is released.

## See it

- The proxy's audit log records a swept request as `request.uncertain` with
  reason `lease_expired`.
- `wardby_proxy_leases_swept_total{estimate="yes|no"}` counts swept requests.
  A sustained rate means proxy processes are stopping mid-request. `estimate="no"`
  means no estimate could be made, so that request keeps its full hold.
- `wardby_proxy_lease_errors_total{stage="renew|sweep"}` counts failed lease
  renewals and sweeps, including ones abandoned because they ran past twice
  their interval (a hung database query); the next one then runs as normal. A
  failing heartbeat lets other proxies settle live requests.

See also [Monitor Wardby](../observability.md),
[Availability and PodDisruptionBudgets](../availability.md) and
[Troubleshoot budgets and reservations](budgets.md).
