---
id: errors/coding-stream-quota-exceeded
title: Coding provider out of credit or over its spend limit
summary: A coding run's model provider refused it because the account is out of credit or over its spend limit; retrying does not help until the limit is raised.
audience: operator
tags: [error, coding-agents, billing, quota, spend-limit, coding_stream_quota_exceeded]
appliesTo: ">=0.6.1"
---

# Coding provider out of credit or over its spend limit

`job_coding_stream_quota_exceeded` in a coding run's diagnostic (the
control-plane log line under the run's `coding_diag_…` id) means the model
provider refused the run's requests because the provider account behind the
coding proxy has run out of credit or reached a spend limit. OpenAI reports
this as `insufficient_quota` or a project spend limit (with HTTP 429, like a
rate limit); Anthropic as a credit balance that is too low. It is not wardby's
own run budget: that ends the run as `budget_exhausted` (see
[errors/budget-exhausted](budget-exhausted.md)).

Retrying does not help: every coding run on that provider account fails the
same way until the limit changes.

1. Check the provider account the coding proxy uses: the OpenAI project's
   billing and limits, or the Anthropic organization's credit balance and spend
   limits.
2. Add credit or raise the limit there.
3. Trigger the run again.

The coding proxy's log for the same request (`audit.*` events) shows the
provider's status. See
[Coding worker isolation](../../docs/coding-worker-isolation.md) for where the
diagnostic and proxy logs live.
