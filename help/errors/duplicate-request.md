---
id: errors/duplicate-request
title: Model request refused as a duplicate (duplicate_reserved, duplicate_completed, duplicate_uncertain)
summary: The coding proxy refused a model request with 409 because its request key matches an earlier request, and what each duplicate_* code and idempotency_conflict means.
audience: operator
tags: [duplicate_reserved, duplicate_completed, duplicate_uncertain, duplicate_released, idempotency_conflict, 409]
appliesTo: ">=0.10.2"
---

# Model request refused as a duplicate

## What happened

The coding proxy identifies a model request by its request key: the
`Idempotency-Key` header if the client sends one, otherwise a hash of the
request body. A request whose key matches an earlier request of the same run
is answered `409` instead of being sent to the model provider again, so one turn
is never billed twice by accident. The code names the earlier request's state:

| Code                   | The earlier request                                                  | Meaning                                                                                                       |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `duplicate_completed`  | Finished; its cost is recorded                                       | The reply is not replayed or resent.                                                                          |
| `duplicate_uncertain`  | Its stream broke under a running proxy, or no estimate could be made | Nobody can say what it cost, so it is not resent.                                                             |
| `duplicate_reserved`   | Reserved with no lease                                               | Reserved before leases existed; it cannot be told from a live request, so it is neither swept nor taken over. |
| `idempotency_conflict` | Any state, with a different body                                     | The same key was used for a different request.                                                                |

A request whose earlier try was `reserved` with a lease is not a duplicate: it
gets `503 wardby_request_in_progress` while the lease runs, and takes over as a
new attempt once it has run out (see `errors/request-in-progress` and
`troubleshooting/stopped-proxy-holds`).

A request whose earlier try was released (the provider refused it, or it failed
before it was sent, so it was never billed and holds nothing) is not a duplicate
either: the same body is sent again as a new attempt, up to three attempts per
request key, then `422 wardby_request_attempts_exhausted`. A different body
under the same key is still `idempotency_conflict`.

Older versions answered such a retry after a provider refusal with
`409 duplicate_released`; current versions send it as a new attempt instead.

## What to do

A single `409` on a retry is usually correct: the first try finished or its
cost is already recorded. If the agent's turn fails with one:

- `duplicate_reserved`: the row predates leases and nothing will settle it
  automatically. It stops counting against the run when the run ends.
- `duplicate_uncertain`: the first try's stream broke under a live proxy, so its
  cost is an estimate at best. Re-run the agent; a new run has its own request
  ledger.
- `idempotency_conflict`: a client reused an `Idempotency-Key` for a different
  body. Fix the client.
