---
id: troubleshooting/coding-workers
title: Troubleshoot coding workers
summary: Investigate coding-worker setup, isolation preflight, and safe failure handling.
audience: operator
tags: [coding-agents, docker, kubernetes, isolation, services, debug-trace, debugTraceMinutes, debugTraceMaxMb, maxOutputTokens, output-tokens, claude-code, codex, memory, CODING_MEMORY_MB, CODING_CPUS, out-of-memory]
appliesTo: >=0.2.1
---

# Troubleshoot coding workers

Before enabling a coding agent, configure an immutable worker image, the
trusted coding proxy, a scoped GitHub App installation, and the selected job
launcher. Run `wardby coding preflight` after changing the Docker or Kubernetes
configuration.

Wardby refuses to weaken an isolation profile when a required host feature,
network setting, mount, environment, or cleanup guarantee cannot be verified.
Investigate the host configuration instead of bypassing the refusal.

Codex and Claude Code workers have different supported launcher combinations.
Review the deployment guide for your target before assigning a coding profile.

For the specific isolation refusal, read [Coding-worker isolation unavailable](../errors/docker-isolation-unsupported.md).

## Cluster preflight at start-up (Kubernetes)

With `JOB_LAUNCHER=kubernetes`, a long-running server process (`wardby
serve`, `wardby mcp` over either transport, or `wardby scheduler`) starts
the cluster preflight as soon as it starts, instead of waiting for the
first coding run. Check the process's start-up log for the result: an info
line when the preflight passes, or a warning naming the failure code (the
same `kubernetes_isolation_unsupported:<check>` codes `wardby coding
preflight` reports) when it does not.

A failed start-up preflight is logged and retried on the next coding run,
not left failing until a restart: fix the underlying configuration and the
next run checks the cluster again on its own. If a run was already
starting at the moment the start-up preflight failed, that one run still
fails with the logged error — it was waiting on that same check — but the
run after it retries. This differs from a preflight failure a coding run
triggers itself (no start-up check ran, or the cluster is still broken when
the next run checks it): that failure does stick, failing every subsequent
run in that process until it is restarted. Run `wardby coding preflight` at
any time for a one-off check against the same cluster.

## Runs that stop at the turn limit

A Claude Code run whose failure category is `turn_limit` reached its agent's
turn limit (worker error `coding_turn_limit`): 200 model calls by default. The
work was too large for the limit, or the agent was looping. Read the run's
summary and debug trace (`codingProfile.debugTraceMinutes`) to tell which;
raise `codingProfile.maxTurns` (up to 1000) with `update_agent` for the first,
or narrow the task for the second. Codex runs have no turn limit. See
[Coding run reached its turn limit](../errors/coding-turn-limit.md).

## Claude Code replies that exceed the output token maximum

A Claude Code run caps each model reply at 32000 output tokens by default,
thinking included. When a reply needs more, Claude Code ends with an error
that the response exceeded the output token maximum and the run fails as a
stream failure. Raise `codingProfile.maxOutputTokens` (1024 to 128000; `null`
restores the default) with `update_agent`, for example
`{ "id": "<agent id>", "codingProfile": { "maxOutputTokens": 64000 } }`. The
coding proxy reserves `maxOutputTokens` × the model's output price against the
run's budget for every model request, so a higher value needs a larger
`budgetUsd`; a request whose reservation does not fit ends the run as
`budget_exhausted` (see the help article `errors/budget-exhausted`), so a small
budget runs out sooner. Codex agents refuse the
setting. The default and the setting need a Claude Code worker image from
Wardby 0.7.0 or later: an older pinned image still caps replies at 4096 tokens
and rejects a run whose agent sets `maxOutputTokens`.

## Runs that die while running checks (out of memory)

A run that fails with `coding_failure_executor` while it runs a linter, a type
check or a test suite has often run out of memory. Each coding pod gets
`CODING_MEMORY_MB` (2048 MiB by default) and `CODING_CPUS` (1 by default). In a
Codex run the agent and its commands share that pod. In a Claude Code run the
commands run in a tool-runner container limited to at most 512 MiB and 0.25 CPU.

1. Turn on a debug trace (below) and run it again. A Node.js crash shows as
   `Aborted` with exit code 134 in a command's output.
2. Raise `CODING_MEMORY_MB` and `CODING_CPUS` on the control plane. On GKE, deploy
   with `CODING_MEMORY_MB=6144 CODING_CPUS=2 deploy/gke/up.sh` (see the GKE deploy
   guide). This applies to every coding run.
3. For a Claude Code agent with heavy checks, run it on Codex instead, since raising
   the pod's memory doesn't raise the tool runner's limit.

## Debug trace

When a run's fixed error code or a slow run doesn't say enough, an admin can
trace the agent's runs for a while:
`update_agent { "id": "<agent id>", "codingProfile": { "debugTraceMinutes": 30 } }`.
Each run dispatched in that window writes its whole agent stream, redacted, to
its worker container's log under a `debugTrace` key. That covers Codex events,
or, for Claude Code (Wardby 0.7.0 or later), every Agent SDK message:
each command the agent ran with its output, the final usage and duration, plus
stream failures in full. For Claude Code, the time between a command's
`tool_use` and its `tool_result` line is how long that command took. A run's
trace stops at 2 MiB by default; set `codingProfile.debugTraceMaxMb` (1 to 64,
admin only) for more. The trace can hold prompts and repository content, so
keep it on briefly. See
[the debug trace section](../../docs/coding-worker-isolation.md#debug-trace)
for where the log lives and what is redacted.

## Runs that wait for cluster capacity

On Kubernetes with `KUBERNETES_RESOURCE_QUOTA` set, a run whose pod would not
fit the namespace quota stays `pending` with `codingQueuedAt` set, like a run
over `CODING_MAX_CONCURRENT`, and starts once other runs finish. A run still
waiting after `CODING_QUEUE_TIMEOUT_SEC` fails with `coding_queue_timeout`:
raise the quota, lower the run pods' size, or lower `CODING_MAX_CONCURRENT` so
fewer runs compete.

A lead agent with `parallelDelegations` starts several coding runs together;
expect some of them to queue when the lead fans out wider than the free slots.

## Service refusals and failures

A repository can declare services such as PostgreSQL in `.wardby/services.yaml`
on its base branch. Wardby checks the declaration, the service catalog, and the
agent's `codingProfile.services` before a run starts, and refuses the run with a
`service_*` code when they disagree. The run's `error` (from `get_run`) is the
code followed by a sentence the requester also sees on the run's status comment.

- [`service_declaration_invalid`](../errors/service-declaration-invalid.md):
  the file on the base branch is not a valid declaration.
- [`service_declaration_unavailable`](../errors/service-declaration-unavailable.md):
  Wardby could not read the file through the GitHub App.
- [`service_unknown`](../errors/service-unknown.md): the catalog has no such
  name and version.
- [`service_not_allowed`](../errors/service-not-allowed.md): the agent does not
  allow that service.
- [`service_launcher_unsupported`](../errors/service-launcher-unsupported.md):
  services need the Kubernetes or Docker job launcher.
- [`service_unready`](../errors/service-unready.md): the run started but a
  service never became ready (launcher error `coding_service_unready:<name>`).

See [Coding services](../coding-services.md).
