---
id: job-launcher-substrate
title: Run coding agents on Substrate (experimental)
summary: JOB_LAUNCHER=substrate runs Claude Code coding runs as two gVisor-sandboxed Agent Substrate actors with no Wardby secret inside; requirements, variables, limits and how it compares with the Docker and Kubernetes launchers.
audience: operator
tags: [substrate, job launcher, JOB_LAUNCHER, gVisor, experimental, SUBSTRATE_ATESPACE, SUBSTRATE_PROXY_PORT, images]
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
  dependency cache, extra repositories or a custom worker image
  (`workerImageRef`).

Otherwise use `kubernetes` (or `docker`): they support Codex and every coding
feature. A run that needs a feature the Substrate backend lacks fails with
[substrate_feature_unsupported](errors/substrate-feature-unsupported.md).

## Set up

1. Install Substrate with a gVisor WorkerPool, the credential provider, router
   and egress gateway; grant the credential provider read access to the
   namespace in `SUBSTRATE_CREDENTIALS_NAMESPACE` (default
   `wardby-run-secrets`) and restart it.
2. Set the Substrate bridge images by digest: `CODING_CLAUDE_WORKER_IMAGE` to
   `substrateAgent`, `CODING_CLAUDE_TOOL_RUNNER_IMAGE` to `substrateTool` and,
   for the Node + Python toolchain,
   `CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12` to
   `substrateToolNodePython`, each from `dist/quickstart-images.json` in the
   installed npm package. For your own images, build the bridge onto them from
   a checkout (see Images in the
   [Substrate backend guide](../docs/substrate-backend.md#images)).
3. Set one blob store (`BLOB_STORE`) on both the control plane and the coding
   proxy.
4. On the control plane set `JOB_LAUNCHER=substrate`, `SUBSTRATE_API_URL`,
   `SUBSTRATE_TOKEN_FILE` (a ServiceAccount token with audience
   `api.ate-system.svc`), `SUBSTRATE_ATESPACE` and `SUBSTRATE_PROXY_HOST`
   (and `SUBSTRATE_PROXY_PORT` if the actors reach the proxy on a port other
   than 8787).
5. On the coding proxy set the same `SUBSTRATE_ATESPACE`,
   `SUBSTRATE_PROXY_HOST` and `SUBSTRATE_PROXY_PORT`, plus
   `SUBSTRATE_ACTOR_JWT_ISSUER`: the issuer of Substrate's own identity
   provider (for example `https://idp.ate-system.svc` in a default install),
   not the cluster's service-account issuer. The proxy fetches its signing keys
   over TLS signed by Substrate's internal CA, so also set
   `NODE_EXTRA_CA_CERTS` on the proxy to the CA bundle from the
   `servicedns.podcert.ate.dev` ClusterTrustBundle.

Every variable, default and limit (`SUBSTRATE_WORKSPACE_MAX_MB` matters for
`gitHistory` runs, which upload the whole `.git`) is in the
[Substrate backend guide](../docs/substrate-backend.md).

## Warm rounds

With `SUBSTRATE_WARM_ROUNDS=true` a finished round is kept suspended and the
next round of the same run chain resumes it, workspace and session included.
See [Warm rounds on Substrate](substrate-warm-rounds.md).

## When a run fails

- [substrate_unavailable](errors/substrate-unavailable.md): the Substrate API
  could not be reached or refused the call.
- [substrate_capacity](errors/substrate-capacity.md): no worker has room; the
  run waits and retries.
- [substrate_provisioning_failed](errors/substrate-provisioning-failed.md):
  creating the run's actors, policies, Secret or files failed.
- [substrate_startup_timeout](errors/substrate-startup-timeout.md): the actors
  never reached the coding proxy.
- [substrate_collect_timeout](errors/substrate-collect-timeout.md): the worker
  exited without a result and the workspace never arrived.
- [substrate_collect_failed](errors/substrate-collect-failed.md): the tool side
  could not set up, archive or upload the workspace (for example one over
  `SUBSTRATE_WORKSPACE_MAX_MB`).
- [substrate_result_missing](errors/substrate-result-missing.md): the run ended
  without a usable result.
- [substrate_feature_unsupported](errors/substrate-feature-unsupported.md): the
  run needs Codex, services, MCP tools, the dependency cache, extra repositories
  or a custom worker image.
- At launch, from the deployment's settings:
  [substrate_image_not_digest](errors/substrate-image-not-digest.md),
  [substrate_seed_too_large](errors/substrate-seed-too-large.md) and
  [substrate_limits_too_small](errors/substrate-limits-too-small.md).

See also [Troubleshoot coding workers](troubleshooting/coding-workers.md),
[Choose a deployment target](deployment-targets.md) and
[Git history in coding runs](git-history.md).
