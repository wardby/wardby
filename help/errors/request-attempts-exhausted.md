---
id: errors/request-attempts-exhausted
title: Model request refused after repeated attempts (wardby_request_attempts_exhausted)
summary: A model request key was tried three times and each earlier try's proxy stopped; the coding proxy answers 422, which clients do not retry.
audience: operator
tags: [wardby_request_attempts_exhausted, request_attempts_exhausted, 422, attempts, retry, coding-proxy, takeover]
appliesTo: ">=0.10.2"
---

# Model request refused after repeated attempts

## What happened

When the proxy that held a model request stops, the worker's retry of the same
request takes over as a new attempt of the same request key (see
`troubleshooting/stopped-proxy-holds`). A request key may have three attempts.
When the third attempt's proxy also stopped and the worker retries again, the
coding proxy refuses with `422` and code `wardby_request_attempts_exhausted`.
`422` is a status the Anthropic and OpenAI client libraries do not retry, so
the agent's turn fails instead of looping.

Each takeover can bill the model provider again for a turn the earlier attempt
may already have been billed for; the limit bounds that exposure. The audit log
records the refusal as `request.rejected` with reason `attempts_exhausted`.

## What to do

Three proxy stops during one request is not routine. Find why proxy pods
keep stopping: out-of-memory kills, node churn, or a rollout. The metric
`wardby_proxy_leases_swept_total` shows how often requests are orphaned (see
`troubleshooting/stopped-proxy-holds`). Re-run the agent once the proxy is
stable. See also `errors/request-in-progress` and `errors/duplicate-request`.
