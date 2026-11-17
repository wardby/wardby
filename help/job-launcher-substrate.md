---
id: job-launcher-substrate
title: Run coding agents on Substrate (experimental)
summary: JOB_LAUNCHER=substrate runs Claude Code coding runs as two gVisor-sandboxed Agent Substrate actors, and Codex runs as one, with no Wardby secret inside; requirements, variables, limits and how it compares with the Docker and Kubernetes launchers.
audience: operator
tags:
  [
    substrate,
    job launcher,
    dependency-cache,
    JOB_LAUNCHER,
    experimental,
    codex,
    repositories,
    multi repository,
    services,
    startCommand,
  ]
appliesTo: ">=0.9.15"
---

# Run coding agents on Substrate (experimental)

`JOB_LAUNCHER=substrate` is an experimental job launcher, next to `docker` and
`kubernetes`. It runs each Claude Code coding run as two
[Agent Substrate](https://github.com/agent-substrate) actors under gVisor: an
agent actor (the worker) and a tool actor (the commands). A Codex coding run is
one actor, which runs the worker and its commands and holds the workspace.
Neither shape holds a Wardby secret; Substrate's egress gateway adds the run
capability to the agent's requests, and the only destination either actor may
reach is the coding proxy.

## Choose it when

- your cluster already runs Substrate 1.0 or later (GKE Standard, not
  Autopilot) and you want its isolation and credential-free actors;
- your coding agents are Claude Code or Codex. Coding services work too: each
  catalog entry a run uses needs a `startCommand` (built-in entries have one);
  see the `coding-services` help article and
  [On the Substrate job launcher](../docs/coding-services.md#on-the-substrate-job-launcher).

Otherwise use `kubernetes` (or `docker`): they support every coding feature. A
run that needs a feature the Substrate backend lacks fails with
[substrate_feature_unsupported](errors/substrate-feature-unsupported.md).

Sandbox-mode native agents can run on Substrate too
(`NATIVE_SANDBOX_LAUNCHER=substrate`, Wardby 0.10.1 and later), sharing the same
`SUBSTRATE_*` connection; see the `native-sandbox` help article and
[Run native agents in a sandbox](native-sandbox.md).

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
   installed npm package. For Codex agents set `CODING_WORKER_IMAGE` to
   `substrateCodex` and, for the Node + Python toolchain,
   `CODING_WORKER_IMAGE_NODE_PYTHON_3_12` to `substrateCodexNodePython`. For
   your own images, build the bridge onto them from a checkout (see Images in the
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

Run the coding proxy of the same release before sending Codex runs. When you
upgrade, go in this order:

1. Apply the `20261121000000_substrate_codex_shape`,
   `20261122000000_substrate_repositories` and
   `20261123000000_substrate_templates` migrations
   (`prisma migrate deploy`). The new proxy reads the `repositories` column on
   every Substrate request, so it must exist before the proxy starts.
2. Start the new coding proxy.
3. Start the new control plane.

Upgrade with no Substrate run in flight, and move the bridge images and every
custom image to the new release's bridge at the same time: the proxy refuses a
bridge of another release
([substrate_bridge_incompatible](errors/substrate-bridge-incompatible.md)).

## MCP tools

Coding agents with attached [remote MCP server](mcp-servers.md) tools run on
Substrate, for Claude Code and Codex. The worker holds only a placeholder:
Substrate's egress gateway adds the run's MCP token in the `X-Wardby-Mcp-Token`
header of `/mcp` requests. Run this release's coding proxy before sending MCP
runs, and set `WARDBY_MCP_GATEWAY_URL` on it. See
[MCP tools on Substrate](../docs/substrate-backend.md#mcp-tools).

## Extra repositories

Runs with [extra repositories](multi-repository-runs.md) work for Claude Code
and Codex. A read repository is read-only by file permissions and never
uploaded, the default repository and the extras share the run's disk limit, and
such runs always start fresh under warm rounds. Run this release's coding proxy
before sending them. See
[Extra repositories on Substrate](../docs/substrate-backend.md#extra-repositories).

## Worker images

The agent actor runs a Substrate bridge image, not the plain worker image: set
`CODING_CLAUDE_WORKER_IMAGE` for Claude Code and `CODING_WORKER_IMAGE` for
Codex to the bridge images by digest (step 2 above).

Every variable, default and limit is in the
[Substrate backend guide](../docs/substrate-backend.md).

## Custom images

Custom worker images (`workerImageRef`) work when they contain this release's
Substrate bridge; see [build-claude-code-image](build-claude-code-image.md),
[build-worker-image](build-worker-image.md) and
[Custom images](../docs/substrate-backend.md#custom-images). The image must be a
registry digest the Substrate workers can pull, and its first run waits while
Substrate builds the template's golden snapshot. Rebuild it on each release's
bridge.

## Dependency cache

The dependency cache works as on Kubernetes; an adopted warm round skips it
(`reused_workspace`). See [dependency-cache](dependency-cache.md) and the
[Substrate backend guide](../docs/substrate-backend.md#dependency-cache).

## Coding services

Coding services (`.wardby/services.yaml`) work for Claude Code and Codex: each
service is a container in the run's workspace actor, and the agent starts only
once every service is ready. Substrate runs each service from its catalog
entry's `startCommand` as the image's default user, so the built-in postgres
and mysql entries carry a non-root `substrateImage` for Substrate (Docker and
Kubernetes keep the official images). The actor is sized with the services'
CPU and memory, and a run with services is never kept between warm rounds. See
the `coding-services` help article and
[On the Substrate job launcher](../docs/coding-services.md#on-the-substrate-job-launcher).

## Warm rounds

With `SUBSTRATE_WARM_ROUNDS=true` a finished round is kept suspended and the
next round of the same run chain resumes it, workspace and session included.
This is Claude Code only; Codex rounds always start fresh.
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
- [substrate_feature_unsupported](errors/substrate-feature-unsupported.md): a
  service's catalog entry cannot start on Substrate (dispatch normally refuses
  it first, with
  [service_launcher_unsupported](errors/service-launcher-unsupported.md)).
- [service_unready](errors/service-unready.md): a coding service never became
  ready (`coding_service_unready:<name>`).
- [substrate_image_unready](errors/substrate-image-unready.md): a template's
  golden snapshot failed twice, or no actor ever started from it (often a
  custom image without the bridge).
- [substrate_template_missing](errors/substrate-template-missing.md): the
  run's actor template is gone from Substrate (a launch creates it again; a warm
  round starts fresh).
- [substrate_bridge_incompatible](errors/substrate-bridge-incompatible.md): the
  image's bridge is from another release than the coding proxy.
- [substrate_image_incomplete](errors/substrate-image-incomplete.md): the image
  runs as root, or lacks the runner, GNU tar, or a writable `/workspace` or
  `/run/wardby`.
- At launch, from the deployment's settings:
  [substrate_image_not_digest](errors/substrate-image-not-digest.md),
  [substrate_seed_too_large](errors/substrate-seed-too-large.md) and
  [substrate_limits_too_small](errors/substrate-limits-too-small.md).

See also [Troubleshoot coding workers](troubleshooting/coding-workers.md),
[Choose a deployment target](deployment-targets.md) and
[Git history in coding runs](git-history.md).
