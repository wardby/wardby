---
id: job-launcher-substrate
title: Run coding agents on Substrate (experimental)
summary: JOB_LAUNCHER=substrate runs Claude Code coding runs as two gVisor-sandboxed Agent Substrate actors with no Wardby secret inside; requirements, variables, limits and how it compares with the Docker and Kubernetes launchers.
audience: operator
tags: [substrate, job launcher, JOB_LAUNCHER, gVisor, coding-agents, experimental, SUBSTRATE_ATESPACE]
appliesTo: ">=0.9.15"
---

# Run coding agents on Substrate (experimental)

`JOB_LAUNCHER=substrate` is an experimental job launcher, next to `docker` and
`kubernetes`. It runs each Claude Code coding run as two
[Agent Substrate](https://github.com/agent-substrate) actors under gVisor: an
agent actor (the worker) and a tool actor (the commands). Neither holds a
Wardby secret; Substrate's egress gateway adds the run capability to the
agent's requests, and the only destination either actor may reach is the coding
proxy.

## Choose it when

- your cluster already runs Substrate 1.0 or later (GKE Standard, not
  Autopilot) and you want its isolation and credential-free actors;
- your coding agents are Claude Code, without coding services, MCP tools, the
  dependency cache or extra repositories.

Otherwise use `kubernetes` (or `docker`): they support Codex and every coding
feature. A run that needs a feature the Substrate backend lacks fails with
[substrate_feature_unsupported](errors/substrate-feature-unsupported.md).

## Set up

1. Install Substrate with a gVisor WorkerPool, the credential provider, router
   and egress gateway; grant the credential provider read access to the
   namespace in `SUBSTRATE_CREDENTIALS_NAMESPACE` (default
   `wardby-run-secrets`) and restart it.
2. Build the Claude worker and tool-runner images with the Substrate bridge
   entrypoint and set their registry digests (`CODING_CLAUDE_WORKER_IMAGE`,
   `CODING_CLAUDE_TOOL_RUNNER_IMAGE`).
3. Set one blob store (`BLOB_STORE`) on both the control plane and the coding
   proxy.
4. On the control plane set `JOB_LAUNCHER=substrate`, `SUBSTRATE_API_URL`,
   `SUBSTRATE_TOKEN_FILE` (a ServiceAccount token with audience
   `api.ate-system.svc`), `SUBSTRATE_ATESPACE` and `SUBSTRATE_PROXY_HOST`.
5. On the coding proxy set the same `SUBSTRATE_ATESPACE` and
   `SUBSTRATE_PROXY_HOST`, plus `SUBSTRATE_ACTOR_JWT_ISSUER`.

Every variable, default and limit (`SUBSTRATE_WORKSPACE_MAX_MB` matters for
`gitHistory` runs, which upload the whole `.git`) is in the
[Substrate backend guide](../docs/substrate-backend.md).

## When a run fails

- [substrate_unavailable](errors/substrate-unavailable.md): the Substrate API
  could not be reached or refused the call.
- [substrate_capacity](errors/substrate-capacity.md): no worker has room; the
  run waits and retries.
- [substrate_startup_timeout](errors/substrate-startup-timeout.md): the actors
  never reached the coding proxy.
- [substrate_collect_timeout](errors/substrate-collect-timeout.md): the agent
  finished but the workspace never arrived.
- [substrate_feature_unsupported](errors/substrate-feature-unsupported.md): the
  run needs Codex, services, MCP tools, the dependency cache or extra
  repositories.

See also [Troubleshoot coding workers](troubleshooting/coding-workers.md),
[Choose a deployment target](deployment-targets.md) and
[Git history in coding runs](git-history.md).
