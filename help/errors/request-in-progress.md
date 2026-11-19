---
id: errors/request-in-progress
title: Model request answered 503 request in progress (wardby_request_in_progress)
summary: A retry of a model request arrived while the earlier try may still be running; the coding proxy answers 503 with a Retry-After until its lease runs out.
audience: operator
tags: [wardby_request_in_progress, request_in_progress, retry-after, 503, lease, retry, coding-proxy, takeover]
appliesTo: ">=0.10.2"
---

# Model request answered 503 request in progress

## What happened

A coding worker sent a model request whose request key matches an earlier
request of the same run that is still `reserved`, and whose proxy still holds
an unexpired lease on it. The request key is the `Idempotency-Key` header if the
client sends one, otherwise a hash of the request body. The earlier request may
still be streaming from the model provider, so the proxy sends nothing upstream
and answers `503` with code `wardby_request_in_progress` and a `Retry-After`
header. `Retry-After` is the lease's remaining time in seconds plus one, so the
retry lands after the lease has run out.

This is the normal answer to a retry that comes quickly after the proxy that
held the original request stopped (a node loss, an out-of-memory kill, a
shutdown past its grace period). It is not a failure of the run: the worker's
client waits and retries, and the retry then takes over as a new attempt (see
`troubleshooting/stopped-proxy-holds`).

## What to do

Usually nothing. If runs fail with this code:

1. Check that the worker's client honours `Retry-After` and retries 503. A
   client that gives up on the first 503 fails the turn.
2. If the proxy that held the earlier request is still alive and slow, the lease
   keeps being renewed and the retry keeps getting this answer until that
   request finishes. Look for a stalled upstream stream.
3. Shorten `CODING_PROXY_LEASE_SECONDS` (it must stay more than twice
   `CODING_PROXY_HEARTBEAT_SECONDS`) if `Retry-After` is longer than your
   client waits.

The code is distinct from `wardby_budget_exhausted` (see `errors/budget-exhausted`),
which ends a run. See also `errors/duplicate-request` and
`errors/request-attempts-exhausted`.
