# Coding Worker Isolation

Wardby runs Codex and Claude Code coding workers through Docker or Kubernetes
launchers. Both fail closed when the effective runtime does not match the
reviewed policy. Claude Code separates its model-facing worker from its
workspace-facing tool runner: Docker uses companion containers, while
Kubernetes uses a native sidecar in the run pod.

## Security Boundary

Coding-agent repositories and instructions are untrusted. The Wardby control
plane, immutable worker images, dedicated coding proxy, and the platform
enforcing container and network policies are trusted.

### Docker launcher

The Docker daemon and host kernel are trusted. Docker containers are defense
in depth rather than a VM boundary. Production should run the Docker host on a
dedicated worker node or VM with no production credentials beyond those
required by the proxy. The Kubernetes launcher section below describes the
corresponding pod and network rules.

The Codex worker has one network attachment: a unique per-run internal bridge using
Docker's isolated gateway mode. It has no default external route, published
port, host mapping, custom DNS server, or direct connection to the control
plane. A dedicated proxy container is attached to both that internal network
as `wardby-proxy` and an external network. No other service may join the run
network.

For a coding run with a package allowlist, the same proxy container also
serves the coding package registry (npm and PyPI) on the same
`wardby-proxy:8787` port, over a separate, registry-only token derived from
the run's capability; npm and pip never receive the run's model-API
capability. See [Installing packages in coding runs](coding-packages.md).
Registry mode serves both providers: Claude Code's tool runner gets that
registry-only token's settings from the trusted launcher, delivered as
`WARDBY_TOOL_SETUP` — never the run capability. Claude Code runs support the
`node` and `node-python` toolchains; the toolchain selects the tool-runner
image, which is resolved when the run is dispatched and kept for the whole run.

Claude Code uses a credential-separated composite job. Its agent container
holds the run capability and is attached only to the proxy network; it never
mounts the repository. Its tool runner container mounts the workspace and
shares that same run network (for a run with services, through the network
keeper's namespace; see below), so it can reach the coding proxy too, but it
holds no model capability or provider credential of its own — only the
registry-only settings and service variables in `WARDBY_TOOL_SETUP`. The two talk over a private
Unix socket (`/run/wardby/tool/runner.sock`). The trade is deliberate: the
tool runner can reach the proxy, but the proxy accepts nothing from it for a
model call. Both containers, the socket volume, keeper, network, and
artifacts are attested and cleaned as one persisted handle. On Docker, the tool
runner gets a fixed 0.25 CPU, a third of the run's memory (clamped between
128 and 512 MiB), and 64 PIDs, and the agent gets the rest, so a Claude Code
run needs `cpus ≥ 0.35`, `memoryMb ≥ 256`, and `pids ≥ 96` (the default
`CODING_PIDS` is 128).

**Upgrading with Claude Code runs in flight (Docker launcher).** Let in-flight
Claude Code runs finish, or stop them, before upgrading the control plane. A
run launched by a different version fails the new version's container
attestation and is reported lost.

The proxy accepts a run-scoped capability, resolves only exact configured HTTPS
hostnames, rejects IP literals and every private, loopback, link-local,
documentation, transition, multicast, and metadata address, rejects mixed DNS
answers, and pins the vetted address into the socket lookup. Redirects are
denied. Injected fetch implementations are a test seam and must not be used in
production composition.

The Codex worker retries a failed model request, or a response stream that
drops, up to three times each before it fails the run. The Claude worker
likewise retries a failed model request up to three times. Every retry is a
new request through the proxy, so it is checked against the run's budget
again.
If the stream still fails, the run's diagnostic (in the control-plane log,
under the run's `coding_diag_…` id) names the cause as a fixed code, never the
error text: `job_coding_stream_proxy_denied` (401/403 from the proxy),
`job_coding_stream_rate_limited` (429), `job_coding_stream_upstream_error`
(5xx), `job_coding_stream_timeout`, `job_coding_stream_proxy_unreachable`
(the worker could not connect), `job_coding_stream_agent_exited` (the agent
process exited without an HTTP error), or `job_coding_stream_failed` when none
of these match. A refusal because the run's budget is used up ends the run as
out of budget instead.

The proxy side of the same request is in the coding proxy's log as
`audit.*` events (`audit.request.reserved`, `audit.response.completed`,
`audit.request.uncertain`, …), with ids, models, amounts and fixed reason
codes only. When the proxy has to end a stream early, `audit.request.uncertain`
says why: `upstream_failed:<code>` when the model API reported a failure (the
failure event is passed on to the worker unchanged), or a code such as
`terminal_usage_missing`, with the upstream response's content type and
encoding. To see the error text behind a code, turn on a
[debug trace](#debug-trace) for the agent.

**Model-provider failures.** The proxy also remembers the first failure the
model provider reported for a run: the error code of a failed stream, or of a
rejected request (its HTTP status as `http_<status>` when the response names no
code). When the run's worker job then fails, the run ends `failed` with the
error `coding_provider_<class>` and the failure category `provider_<class>`,
where the class is:

| Category                | Provider codes                                                                                                        | What the host is told                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider_quota`        | codes naming a quota, spend limit, billing, funds or credit (`insufficient_quota`, `project_spend_limit_exceeded`, …) | "The model provider refused the request: its account has reached a spending or quota limit. An operator needs to raise the limit with the provider, then retry." |
| `provider_rate_limited` | `rate_limit_exceeded` and other rate-limit codes                                                                      | "The model provider is rate-limiting requests. Try again later."                                                                                                 |
| `provider_unavailable`  | `server_error`, `overloaded`, `overloaded_error`, `service_unavailable`, `api_error`, `http_5xx`                      | "The model provider reported an outage or overload. Try again later."                                                                                            |
| `provider_rejected`     | anything else                                                                                                         | "The model provider rejected the request."                                                                                                                       |

The host sees that sentence in the continuation status comment
(`❌ <agent> could not run: …`) and in an @-mention's status comment
(`❌ A sub-run could not reach the model: …`); it never sees the provider's
code or message. `provider_quota` means the **provider account** behind the
coding credential is out of quota or has hit its spend limit — raise the limit
with the provider. It is not wardby's budget: a run that uses up its own
wardby budget still ends `budget_exhausted`, and that wins when both happen.

For alerting, the control plane logs one `warn` line per such run with
`event: "coding.provider_failure"`, the `runId`, the `class`, and the raw
`upstreamCode`.

### Model request allowlist

The network policy only helps if the one reachable destination, the proxy,
cannot be asked to reach somewhere else. Model APIs can do that on the
caller's behalf: an OpenAI hosted `mcp` tool or a remote `input_image` URL
makes OpenAI's servers contact any host, and hosted-tool fees and non-default
service tiers are billed outside the metered tokens. Code in a Codex worker can
read the run capability, so the proxy validates every request body against an
allowlist before it resolves a credential, and refuses anything else with a
`400` (`src/providers/coding-proxy/proxy.ts`). Each refusal is also written to
the proxy audit log as `request.rejected` with the run id and the refusal
code, so a smuggling attempt is attributable to its run. JSON nested too
deeply to process is refused with `request_nesting_too_deep`.

- **Anthropic Messages** (`parseAnthropicRequest`): a fixed set of keys,
  text/`tool_use`/`tool_result`/thinking blocks, exactly the two Wardby tool
  names, the reviewed beta values, the thinking mode the run's model catalog
  entry names, and only effort levels that entry lists in `efforts` (top-level,
  or on an effort-only system message for models that change effort per turn).
- **OpenAI Responses** (`parseOpenAiRequest`), built from what the pinned
  Codex CLI actually sends (recorded in
  `src/providers/coding-proxy/fixtures/codex-<version>-responses-requests.json`
  and exercised end to end by `src/coding-worker/codex-compatibility.test.ts`):
  - Top-level keys: `model`, `instructions`, `input`, `tools`, `tool_choice`,
    `parallel_tool_calls`, `reasoning`, `store`, `stream`, `include`,
    `prompt_cache_key`, `text`, `client_metadata`, `max_output_tokens`,
    `background`, `service_tier`. Any other key, including `prompt`,
    `previous_response_id`, `conversation` and `metadata`, is refused with
    `openai_request_key_not_allowed:<key>`.
  - Tools: `function` and `custom` definitions, and `namespace` groups of
    them, either in `tools` or in Codex's `additional_tools` input item. Every
    other tool type, including all hosted tools (`web_search`, `mcp`,
    `code_interpreter`, `image_generation`, `file_search`, `local_shell`, and
    so on), is refused with `openai_tool_not_allowed:<type>`. Tool names are
    checked for shape (`[A-Za-z0-9_-]{1,128}`) but not against a fixed list:
    they change with the model and the Codex version (for example `exec` in
    code mode against `exec_command` otherwise), and a client-side tool runs
    inside the worker, where the container boundary already governs it.
    `tool_choice` may only be `auto`, `none` or `required`.
  - Input items: `message` (`input_text`/`input_image` for user, developer
    and system; `output_text` for assistant), `reasoning`, `function_call`,
    `function_call_output`, `custom_tool_call`, `custom_tool_call_output`,
    `agent_message` and `additional_tools`, each with only the keys Codex
    sends. Anything else (`input_file`, `input_audio`, `item_reference`,
    replayed hosted-tool calls, `compaction`, `local_shell_call`) is refused
    with `openai_input_not_allowed:<type>`. An `input_image` must be an inline
    `data:image/{png,jpeg,gif,webp};base64,` URL, as Codex's `view_image`
    produces; a remote URL or a `file_id` is refused with
    `openai_remote_input_not_allowed`.
  - Pinned values: `include` only `reasoning.encrypted_content`; `reasoning`
    only `effort`, `summary` and `context` with known values; `text` only
    `verbosity` and a `text` or `json_schema` format; `service_tier` only
    unset or `default` (`service_tier_not_allowed`; `auto` is refused because
    it defers to the OpenAI project's own tier, which may be priority);
    `client_metadata` only the string-valued keys Codex sends
    (`openai_client_metadata_key_not_allowed:<key>`). The proxy still
    forces `store: false` and `background: false` and adds a
    `max_output_tokens` ceiling when Codex omits it.

A Codex release that sends a new key or item type fails closed at the proxy
rather than silently widening what reaches OpenAI. Upgrading the pinned
`@openai/codex-sdk` is therefore one command plus a review:

1. Change the pin in `src/coding-worker/package.json` (a dependency bot's
   pull request does this). Until the fixture is re-recorded, the "pinned
   Codex version" test fails with `Codex SDK bump detected (...)`.
2. On that branch, run `npm run codex:rerecord` on a machine where npm
   installs the host's Codex binary. It sets the root devDependency
   `@openai/codex-sdk` to the worker's pin and installs it, drives the pinned
   Codex CLI through a fixed set of scenarios (responses-lite and classic tool
   layouts, code-mode `exec` with `view_image` and `apply_patch`, namespaced
   tool calls, a spawned sub-agent, local context compaction) against a local
   fake of the proxy's `/v1/responses` endpoint — nothing is sent to OpenAI —
   and writes `codex-<version>-responses-requests.json`, replacing the
   previous version's fixture. Paths, ids, timestamps and long prompt texts
   are normalized so a re-record of the same version is byte-identical. It
   then runs the compatibility test (the real Codex through the real proxy)
   and the proxy's fixture-replay tests, and prints a request-shape diff
   against the previous fixture: new or removed top-level keys, input item
   and content types, tool types, `include`/`reasoning`/`text`/`tool_choice`/
   `service_tier` values and `client_metadata` keys.
3. Review that diff. If the tests pass and the diff is empty or shows only
   shapes the allowlist already accepts, commit the new fixture with
   `package.json` and `package-lock.json`. If the proxy refuses a request
   (an `openai_*_not_allowed` code in the test output), do not widen the
   allowlist to make it pass: first find out what the new key, item, tool
   type or value does (Codex's changelog and source) and whether it can
   reach anything outside the worker or bill outside the metered tokens,
   then widen `parseOpenAiRequest` only for what that review accepts, and
   document it in the list above.

The proxy also binds a second listener, the **deny port** (`8788`,
`CODING_PROXY_DENY_PORT`), which serves nothing: it accepts a connection,
sends no bytes and closes it immediately
(`src/providers/coding-proxy/deny-port.ts`). It exists so a run pod can prove
its own NetworkPolicy is enforced — see "The enforcement gate" below.

The deny port ships to **every** deployment, not just Kubernetes:
`startConfiguredCodingProxy` is the only proxy entry point, so a Docker
deployment's proxy also binds `0.0.0.0:8788` (and refuses to start if it
cannot). No host port is published for it, so there is no port conflict. In
Docker mode a run container can reach it, since a Docker network has no
port-level policy — that is harmless, because the listener accepts the
connection, sends nothing and closes it. It is not a leak; it is a fact about
reachability that the Kubernetes launcher turns into evidence.

## Debug trace

When a fixed code is not enough to tell why a coding agent's runs fail, an
admin can turn on a **debug trace** for that agent for a limited time:

```
update_agent { "id": "<agent id>", "codingProfile": { "debugTraceMinutes": 30 } }
```

`debugTraceMinutes` is 1 to 1440 and needs the `agents:admin` scope (the admin
role), as `workerImageRef` does; `null` turns the trace off early. Every change
is written to the control-plane log as a `coding.debug_trace.set` audit line.
`get_agent` shows the expiry as `codingProfile.debugTraceUntil`. The trace
expires on its own: each coding run dispatched before the expiry is traced for
its whole life, and `get_run` shows `debugTrace: true` for it. Runs dispatched
afterwards are not.

A traced run's Codex worker writes every Codex stream event, and the full text
of a stream failure (including the agent process's own error output and cause
chain), to its **own log**, one JSON line each under a `debugTrace` key. On
Kubernetes that is the run pod's `worker` container log; on GKE, Cloud Logging
keeps it after the pod is deleted. With the Docker launcher it is the worker
container's log (`docker logs`), for as long as the container exists. Nothing from the trace goes to the database,
GitHub, the run's error, or the control-plane log. Token-shaped values (the run
capability, bearer tokens, API keys, GitHub tokens) are redacted, each line is
capped at 16 KiB and each run at 2 MiB.

The trace can contain prompts, model output and repository content. Turn it on
only while diagnosing a failure, for as short a time as you can, and treat the
pod logs of traced runs as sensitive. Tracing needs a worker driver image that
supports it; a worker that predates it rejects a traced run's input as
invalid.

## Container Policy

`src/providers/jobs/docker-isolation.ts` is the canonical policy builder and
startup attestation layer. `DockerJobLauncher` executes its argument arrays
directly with `spawn`; it never invokes a shell.

The worker policy requires:

- An immutable `sha256:` image ID or repository digest with `--pull never`.
- UID/GID `10001:10001`, all capabilities dropped, no new privileges, Docker's
  built-in seccomp profile, private cgroup and PID namespaces, and no host IPC.
- A read-only root filesystem with bounded `noexec,nosuid,nodev` tmpfs mounts
  for `/tmp` and `/home/wardby`. The agent's own temporary files (`TMPDIR`)
  are not among them: they go to the workspace's `.cache/tmp`, which is
  disk-backed and counts toward the run's `workspaceDiskMb`, not this small
  in-memory scratch — a real `pip install` or `npm install` unpacks and builds
  in `TMPDIR`, which the tmpfs is usually too small to hold. `.cache` is
  never part of the collected diff or pull request.
- Exact CPU, memory, equal memory+swap, PID, shared-memory, disk, and wall-clock
  limits. Equal memory and memory+swap disables additional swap allowance.
- No devices, device requests, bind mounts, extra groups, custom DNS, extra
  hosts, published ports, or restart policy.
- At most 2 MiB of local Docker logs and a cooperative SIGTERM grace period
  before forced termination.

A run with services (see [coding-services.md](coding-services.md)) adds two
kinds of container, both labelled and attested like the others before they
start:

- A **network keeper** (`wardby-netns-<token>`): the worker image running an
  idle `node` process as `10001:10001`, read-only, all capabilities dropped,
  no new privileges, built-in seccomp, 64 MiB and 32 PIDs, with no mounts, on
  the run's internal network. It owns the run's network namespace.
- One container per service (`wardby-svc-<token>-<name>`): the catalog image
  by digest, as `10001:10001`, with a read-only root filesystem, all
  capabilities dropped, no new privileges, built-in seccomp, private cgroup
  namespace, private IPC with 64 MiB of shared memory, the catalog's CPU,
  memory (plus its tmpfs disk and shared memory), 512 PIDs, a bounded tmpfs at
  its data path and each writable path, its catalog `serviceEnv`, and no
  published ports, mounts, devices or restart policy.

A Codex run's worker and every service use `--network container:<network
keeper>`, so a service answers the worker on `127.0.0.1` and the worker still
reaches the proxy by its alias on the internal network. Nothing else about the
worker changes.

For a Claude Code run it is the tool runner, which runs the agent's shell
commands, that joins the network keeper's namespace: it reaches every service
on `127.0.0.1` and the proxy by its alias, and it is created only after every
service is ready. The agent container stays on the run's internal network,
unchanged; it reaches the tool runner over the Unix socket in their shared
storage volume, which does not depend on either container's network. The
launcher attests the tool runner's network before it starts and on every
status check: the network keeper's namespace and no network of its own.

A service may listen on every interface of the network keeper's namespace, so
anything on the run's internal network (the proxy, and for a Claude Code run
the agent container) can address it there, just as every container in a
Kubernetes run's pod shares the services' namespace. Services are disposable
test fixtures with catalog credentials; do not treat them as a boundary.

The capability value is inherited from the trusted launcher's child-process
environment with `--env WARDBY_RUN_CAPABILITY`; it is never included in command
arguments. Docker administrators can still inspect container environment, so
daemon access remains privileged and must be tightly restricted.

## Ephemeral Storage

Each run receives one quota-bounded local tmpfs volume. A hardened, no-network
keeper container holds the volume open from preparation through result
collection. It creates exactly four private subdirectories and emits
`wardby_storage_ready` before the launcher may seed them.

The worker sees only these volume subpaths:

- `/workspace`: read-write checkout files.
- Git metadata remains in the trusted keeper volume and is not mounted into the worker.
- `/run/wardby/input`: read-only, validated input artifact.
- `/run/wardby/output`: read-write result artifact.

There are no production host bind mounts. The Docker JobLauncher transfers data
through the keeper with Docker copy/archive APIs, validates it before launch and
after collection, and stops the keeper only after collection. Stopping the last
container that mounts this local tmpfs intentionally destroys the run data.
The quota is RAM-backed; operators must bound aggregate concurrent `diskMb`
allocations at the host scheduler as well as per run.

## Required Lifecycle

1. Validate `JobSpec`, image digest, proxy identity, and host support.
2. Create and inspect the internal network and tmpfs volume.
3. Create, inspect, and start the keeper; wait for its readiness marker.
4. Seed the four fixed storage areas through the keeper, never a bind mount.
5. Attach the dedicated proxy and attest that it is both internally and
   externally connected.
6. For a run with services only: create, inspect and start the network
   keeper; then, for each service in turn, use the host's copy of its image or
   pull it by digest, create and inspect its container in the keeper's
   namespace, start it, and run its readiness command until it passes or the
   run fails with `coding_service_unready:<name>`. All of this shares one
   120-second start-up limit (image pulls, each bounded to 5 minutes, are not
   counted) and never runs past the run's deadline.
   A Claude Code run's tool runner is created, inspected and started only
   after this step, in the network keeper's namespace.
7. Create the worker with the run capability supplied only in the child
   environment; inspect every effective control before start.
8. Start the worker and enforce `deadlineMs`. Send SIGTERM at expiry, then
   SIGKILL after `stopGraceSeconds` if it remains alive.
9. Cancel the proxy session, collect and validate bounded output, and re-read
   authoritative usage before any repository publication.
10. For `changes_ready` only, copy the worker workspace into a new host staging
    directory, reject special files, nested `.git`, escaping symlinks, and size
    or entry-limit violations, then atomically replace the trusted checkout.
11. Revalidate protected paths, Git configuration, branch ancestry, remotes,
    and budget; create one controlled commit, push one deterministic branch,
    and create or find one draft pull request.
12. Persist the typed coding result and terminal run status in one transaction,
    then remove the worker, any service containers and network keeper, the
    keeper, network, volume, input artifact, and VCS workspace. `no_changes`
    and `budget_exhausted` never push.

`ContainerExecutor` treats a durable proxy session without a durable job handle
as ambiguous provisioning and never relaunches it. A persisted handle is the
only recovery path. Duplicate starts, terminal collection, Git finalization,
and cleanup converge on the same handle, branch, commit, pull request, usage,
and status.

Any missing host feature, unsupported network option, failed inspection,
unexpected mount/network/environment, or cleanup ambiguity is the fixed
`docker_isolation_unsupported` failure. Production must not fall back to a
weaker profile.

## Control Plane Configuration

Set `JOB_LAUNCHER=docker` and `CODING_PROXY_CONTAINER` to the dedicated proxy
container name, plus the worker images for the providers you use, each an
immutable repository digest or Docker local image ID: `CODING_WORKER_IMAGE` for
Codex agents, and `CODING_CLAUDE_WORKER_IMAGE` plus
`CODING_CLAUDE_TOOL_RUNNER_IMAGE` for Claude Code agents. At least one
provider's images must be set or the control plane refuses to start. Without
`CODING_WORKER_IMAGE`, a Codex agent that doesn't name its own `workerImageRef`
is refused with `coding_provider_not_configured:codex`; see
[Coding provider not configured](../help/errors/coding-provider-not-configured.md).
To let agents use git repositories on the control plane's own machine
(`local:/absolute/path`), also set `LOCAL_REPO_ROOTS` to the trusted folders; see
[Local repositories](coding-agent-setup.md#local-repositories).
`VCS_WORK_ROOT`, `CODING_JOB_STATE_ROOT`, and `CODING_ARTIFACT_ROOT` must be
trusted host-only directories. Resource limits are controlled by
`CODING_CPUS`, `CODING_MEMORY_MB`, `CODING_PIDS`, and `CODING_DISK_MB`.
`CODING_MAX_DISK_MB` (must be an integer between 64 and 32768 and at least
the effective `CODING_DISK_MB`; **defaults to the effective `CODING_DISK_MB`
itself**, not a larger number) is the operator ceiling on the per-agent
`workspaceDiskMb` coding-profile field described below — without it, any
`agents:write` caller could size a run's workspace disk up to 32 GiB
(Docker: a RAM-backed tmpfs; Kubernetes: an `emptyDir`), times
`CODING_MAX_CONCURRENT`, on every run. Defaulting the ceiling to the
existing disk size means upgrading to this branch changes nothing for a
deployment that doesn't set `CODING_MAX_DISK_MB`: `workspaceDiskMb` stays
inert until an operator explicitly raises the ceiling above `CODING_DISK_MB`.

A coding agent's profile carries an optional `workspaceDiskMb` (MiB; `null`
means "use the deployment default `CODING_DISK_MB`"). It is snapshotted onto
the `CodingRun` at dispatch time, so a later profile edit never changes an
in-flight run's size, and it is capped by `CODING_MAX_DISK_MB`: a run whose
snapshotted `workspaceDiskMb` exceeds the ceiling fails with
`coding_workspace_disk_exceeds_limit`
(`src/providers/executor/container.ts`, the `jobSpec()` check). This check
runs after the workspace has already been cloned onto the control plane, so
an over-ceiling agent still pays for a clone before failing, and the failure
reaches the run record only as the sanitized `coding_failure_workspace:<id>`
(the same generic bucketing every workspace/git-related failure gets) — not
a distinctly labeled "refused" outcome, and not currently logged anywhere
more diagnosable on the control plane. This is a known rough edge, not a
security gap: no run ever exceeds the ceiling, it
just fails less legibly than it could.

`CODING_MAX_CONCURRENT` (default `4`) caps coding runs that hold a slot at
once, across every control-plane replica: the cap is enforced in Postgres
inside the provisioning claim, so adding replicas never raises it. A run
over the cap stays `pending` and `get_run`/`list_runs` show `codingQueuedAt`;
it starts, oldest first, when a slot frees (immediately in the process whose
run finished, or on the scheduler leader's next tick). A newly dispatched run
never takes a free slot ahead of an older queued run. A run still queued after
`CODING_QUEUE_TIMEOUT_SEC` (default `3600`) fails with `coding_queue_timeout`.
Slot usage is derived from run state, so a crashed replica cannot leak slots:
its runs are reconciled to `lost`, which frees them.

A native lead with `parallelDelegations` can dispatch several coding runs at
once. They count against `CODING_MAX_CONCURRENT` like any other runs, and the
ones over the cap queue. The lead waits for each run's queue time plus its
`timeoutSec` before giving up on it, so size `CODING_QUEUE_TIMEOUT_SEC` and the
cap for the fan-out you expect.

On Kubernetes, a run slot is not enough on its own: the namespace's
ResourceQuota can be full even when slots are free, because run pods differ in
size (a service sidecar adds to a run's CPU and memory) and other pods share the
quota. Set `KUBERNETES_RESOURCE_QUOTA` to the quota's name and the launcher
checks, before a run claims a slot, whether the pod it would create fits the
quota's free room. A run that doesn't fit is queued the same way as a run over
`CODING_MAX_CONCURRENT`, and is retried when a run ends and on each leader tick;
without the check, the API server refuses the pod and the run fails. The check
reads one ResourceQuota by name (`get` on `resourcequotas` with that
`resourceName` in the launcher's Role). If the quota is missing or can't be
read, the launcher logs `kubernetes_resource_quota_missing` or
`kubernetes_resource_quota_unreadable` once and launches as before. Size
`CODING_MAX_CONCURRENT` to the quota too, so slots and quota agree.

Operating the queue across replicas:

- Every replica must set the same `CODING_MAX_CONCURRENT`. Each claim
  enforces the value of the replica making it, so mismatched values make the
  effective cap depend on which replica dispatched the run.
- Draining on a timer and applying `CODING_QUEUE_TIMEOUT_SEC` need a
  scheduler process (`wardby serve` or `wardby scheduler`). A process that
  only serves MCP (`wardby mcp`) drains only when one of its own coding runs
  finishes; without a scheduler somewhere, queued runs can wait indefinitely
  and never time out.
- Upgrade all replicas together. A replica running a version from before
  the queue ignores the cap, and its reconciler reaps queued runs as `lost`. Clones are shallow
  (`--depth 1`); the worker never receives Git history and finalization needs
  only the base commit.

Every wardby process also polls the model catalog on
`WARDBY_MODEL_CATALOG_REFRESH_SECONDS` (default `45`), which decides whether
a coding run's model is still available and how it is priced at dispatch; see
[Models and pricing](models.md).

The GitHub adapter requires `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`; the
App installation is checked while preparing the workspace, before the
billable proxy session is created. The server still starts without them (so it
can serve local repositories alone), but a run on a GitHub repository then fails
with `vcs_github_not_configured`, and with neither these nor `LOCAL_REPO_ROOTS`
set the server logs a startup warning naming both. Upstream keys remain behind
`CODING_OPENAI_CREDENTIAL_REF` and `CODING_ANTHROPIC_CREDENTIAL_REF` and are
never written to the database, input
artifact, Docker arguments, or Git workspace.

The embedded Codex SDK runs with its inner sandbox disabled because the
worker's Docker boundary is authoritative: it has a read-only root filesystem,
no Linux capabilities, no host mounts or Docker socket, no public network,
and only isolated workspace/output volumes plus the trusted proxy connection.
This avoids relying on a nested sandbox that cannot validate Wardby's
intentionally Git-metadata-free workspace.

Coding-agent authoring and execution are MCP-first. `trigger_agent` accepts
an optional bounded `task` and `baseRef` only for a coding agent owned by the
caller; the chosen values are copied into the immutable run record. Webhooks
use the profile default task unless `allowWebhookTaskOverride` is explicitly
enabled on that coding profile. Coding results returned through `get_run` and
`tasks/get` are validated, redacted summaries/tests only; job handles and
execution policy stay internal.

The worker receives only its task text, so a coding agent's own `systemPrompt`
is placed ahead of the request at dispatch ("Standing instructions for this
coding agent: … Request: …") and stored with the run. A blank prompt leaves
the task unchanged; a combination over the 16 KiB task limit is refused rather
than truncated.

The worker's result may carry an optional `tag`, shown as `[tag]` in the pull
request title: at most 32 characters of letters, digits, `.`, `_`, `/`, and
`-`, starting with a letter or digit. The output schema describes that rule to
the model, and a tag that breaks it is normalized to a lowercase slug (or
dropped) instead of failing an otherwise finished run. GitHub finalization
re-validates the tag independently. Linking an issue is not the tag's job: put
a closing keyword such as `Resolves #37` in the task so the worker includes it
in the summary, which becomes the pull request body.

Some workspace folders are never collected from a run: `node_modules`, `.venv`,
`venv`, `__pycache__`, `.pytest_cache`, `.ruff_cache`, `.mypy_cache`, `.tox`,
`.vite`, and `.cache`, at any depth, plus any repository-relative paths in the
agent's `collectExclude` (for example `web/dist`). On Kubernetes the keeper's
`tar` leaves them out, so they never leave the pod; on Docker they are removed
from the staging copy before it is validated. They therefore never count toward
the entry, size, symlink, or nested-repository checks, and Git staging excludes
them too, so a tracked file under an excluded folder is left unchanged.

Operator-only checks and cleanup remain available through the CLI:

```sh
wardby coding preflight
wardby coding cleanup --run-id <id>
```

The preflight command requires Docker mode, validates the pinned worker-image
digest, and confirms the image is available to Docker. Cleanup delegates to
the configured executor so it resolves and stops the persisted container job.

## Audit And Retention

The executor emits metadata-only lifecycle events for queueing, preparation,
launch, running, budget cutoff, stopping, collection, PR creation, terminal
outcome, and cleanup. Events carry run ID, opaque job ID, sanitized failure
category, opaque diagnostic ID, duration, and budget totals only. They never
carry task text, prompts, repository contents, diffs, worker environment, raw
Docker logs, or credentials.

The production log/metrics collector retains those events for 90 days by
default policy. `CodingRun` stores only the sanitized failure category and
diagnostic ID alongside the normal run record; it is not an artifact store.
Every terminal path removes the worker volume, input artifact, job state, and
trusted checkout. Restart reconciliation repeats that cleanup from the
persisted job handle and marks ambiguous provisioning as `lost` instead of
relaunching it.

See [release verification](release-verification.md) for automated gates and
live-fixture rules.

## Kubernetes launcher (`JOB_LAUNCHER=kubernetes`)

`KubernetesJobLauncher` (`src/providers/jobs/kubernetes.ts`) implements the
same `WorkspaceJobLauncher` contract as `DockerJobLauncher` and is a drop-in
alternative for deployments with no Docker daemon available to the control
plane (e.g. a Cloud Run host). Everything above `ContainerExecutor` —
proxy sessions, the Git finalizer, workspace validation, recovery, cleanup —
is unchanged; only the container-orchestration seam is replaced. Both Codex
and Claude Code run on this launcher; Claude Code's pod adds a tool-runner
sidecar, described in "Pod layout" below.

### Enabling it

Set `JOB_LAUNCHER=kubernetes` and the worker images for the providers you
use, each a **registry digest** (`repo@sha256:<64 hex>` — a bare `sha256:`
local image ID is rejected; a cluster cannot pull it): `CODING_WORKER_IMAGE`
for Codex agents, and `CODING_CLAUDE_WORKER_IMAGE` plus
`CODING_CLAUDE_TOOL_RUNNER_IMAGE` (and, for Claude agents on the `node-python`
toolchain, `CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12`) for Claude Code
agents. At least one provider's images must be set, and the control plane
refuses to start if any image that is set is anything but a registry digest.
Without `CODING_WORKER_IMAGE`, a Codex agent that doesn't name its own
`workerImageRef` is refused with `coding_provider_not_configured:codex`.
Kubernetes-specific settings (`src/config/providers.ts`,
`loadKubernetesJobConfig`):

| Variable                        | Default                                         | Meaning                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KUBERNETES_NAMESPACE`          | `wardby-coding`                                 | The one namespace holding the proxy and every per-run object.                                                                                                                                                                                                                                         |
| `KUBERNETES_PROXY_SERVICE`      | `wardby-coding-proxy`                           | The proxy's Service name; its ClusterIP is what `hostAliases` points runs at.                                                                                                                                                                                                                         |
| `KUBERNETES_CONTEXT`            | (unset → in-cluster/default kubeconfig context) | Which kubeconfig context `ClientNodeKubernetesApi` connects with.                                                                                                                                                                                                                                     |
| `KUBERNETES_RUNTIME_CLASS`      | (unset)                                         | e.g. `gvisor` on GKE. Unset means pods run without a sandboxing runtime class — logged once per launch as `kubernetes_runtime_class_unset` and development-only.                                                                                                                                      |
| `KUBERNETES_RESOURCE_QUOTA`     | (unset)                                         | Name of the namespace ResourceQuota run pods count against, e.g. `wardby-coding` in the GKE overlay. When set, a run whose pod would not fit the quota's free room waits in the coding queue instead of failing at pod create. Needs `get` on that one `resourcequotas` object. Unset means no check. |
| `KUBERNETES_RUN_PRIORITY_CLASS` | (unset)                                         | PriorityClass for run pods and the preflight canary, e.g. `wardby-coding-run` in the GKE overlay. Must be an existing class and a DNS-1123 subdomain; `system-` classes are refused. Unset means no class (priority 0).                                                                               |

The `CODING_CPUS` / `CODING_MEMORY_MB` / `CODING_PIDS` / `CODING_DISK_MB` /
`CODING_MAX_DISK_MB` settings above apply identically; the per-agent
`workspaceDiskMb` profile field sizes the pod's `storage` `emptyDir` the same
way it sizes Docker's tmpfs volume.

### Pod layout

One pod per run, built by the canonical, deny-by-default policy in
`kubernetes-isolation.ts`'s `buildRunPod`:

- An **init container `storage-init`** runs first and creates
  `/run/wardby/storage/{workspace,input,output}` (mode `0700`, owned by uid 10001) before any regular container starts. This exists because kubelet
  creates a subPath mount's target directory root-owned the first time it
  sets up the worker's volume mounts, and the keeper (uid 10001, no Linux
  capabilities) cannot `chmod` a root-owned directory it doesn't own. This
  is required because otherwise a real-cluster run fails
  `kubernetes_pod_start_timeout`. `keeper.js` itself is unchanged — Docker still
  shares it, and Docker's bind-mount-free volume never had this problem.
- **Claude Code's `tool-runner`** (only for a Claude Code run): a native
  sidecar (init container with `restartPolicy: Always`) after `storage-init`
  and before the service sidecars, `keeper`, and `worker`. It mounts the
  workspace and the socket directory `/run/wardby/tool`, gets its `WARDBY_TOOL_SETUP`
  environment variable from the run Secret's `tool-setup` key (never the run
  capability), and shares the pod's network and IPC namespaces with the
  worker, like every container in a pod: loopback and abstract Unix sockets
  are common to both, and the worker listens on nothing. The run's one egress
  rule (the proxy) applies to it the same as the worker. Unlike on Docker
  (where it runs under `--init`), it has no init process on Kubernetes; it
  stops when the pod is deleted. Its
  `startupProbe` runs `test -S /run/wardby/tool/runner.sock`, so the keeper
  and worker wait for the socket to exist before they start. The socket
  directory is its own small memory-backed `emptyDir` (`tool-socket`),
  mounted by the tool runner and the worker only, never a subdirectory of the
  disk-backed storage volume: under gVisor a Unix socket bound on a volume
  that isn't shared across the sandbox is invisible to the other container,
  while a memory-backed `emptyDir` that two containers mount is one shared
  tmpfs (GKE Autopilot annotates it `share: pod`). Before it calls the model,
  the Claude worker connects to the socket once and fails the run as
  `worker_tool_runner_unreachable` if it can't, so a run never proceeds
  without its command tool. Of the pod's
  resources, the tool runner gets a fixed 0.25 CPU and a third of the run's
  memory (clamped between 128 and 512 MiB); the agent (`worker`) gets the
  rest of both. The two also split the worker's 1024 MiB ephemeral-storage
  reservation: 256 MiB to the tool runner, 768 MiB to the agent. GKE
  Autopilot may round each container's requests up to its own minimums, so
  there the split is approximate.
- **Service sidecars** (only for a run with services, see
  [coding-services.md](coding-services.md)): one init container per service,
  `service-<name>`, with `restartPolicy: Always` and a `startupProbe` from its
  catalog entry — this native-sidecar shape (an init container that keeps
  running) needs Kubernetes 1.29 or later — after `storage-init` (and, for a
  Claude Code run, `tool-runner`) and before `keeper` and `worker`, so
  neither starts until every service is ready. Each runs its catalog image,
  pinned by digest, with the same security context as every other container
  (uid 10001, read-only root filesystem, no privilege escalation, all
  capabilities dropped), `emptyDir` volumes at its data and writable paths, and
  requests equal to limits. It shares the pod's network namespace, so the worker
  reaches it on `127.0.0.1` and the run's NetworkPolicy is unchanged: a service
  can reach nothing the worker cannot. For a Claude Code run, the tool runner
  reaches it on `127.0.0.1` too, and gets the same catalog `testEnv` the worker
  would. The worker never receives a service's own
  environment, only the catalog's `testEnv`. Attestation compares sidecars like
  every other container.
- **`keeper`**: trusted, holds the one `storage` volume (an `emptyDir` sized
  `spec.limits.diskMb` MiB, **disk-backed**, not `medium: Memory`) open for
  the pod's life; the seam streams the workspace and input artifact in and
  the output artifact out through it via `kubectl exec`-style calls
  (`tar` in/out). Readiness probe: the `output` subdirectory exists.
- **`worker`**: untrusted. Its command is overridden to a small polling gate
  (`WORKER_GATE`) that waits for `/run/wardby/input/.seeded` before
  `import()`-ing the image's real entrypoint — for a Claude Code run, the
  Claude entrypoint, which never mounts `/workspace` (only `/run/wardby/tool`,
  to reach the socket, plus `input` and `output`). A pod's containers all
  start together — Kubernetes has no "start this container later" — so the
  gate is what makes "seed first, run second" possible without a native
  sidecar (which Kubernetes terminates when the main container exits, killing
  the keeper before result collection).
- `/tmp` and `/home/wardby` are small `medium: Memory` `emptyDir`s (bounded
  `min(64, max(16, memoryMb/8))` MiB), matching Docker's bounded tmpfs mounts;
  a Claude Code run's tool runner gets its own pair, sized the same way from
  its own memory share. Neither is where the agent's commands get `TMPDIR`:
  that points at the workspace's `.cache/tmp` on the disk-backed `storage`
  volume instead, so it scales with `workspaceDiskMb` rather than this tiny
  in-memory scratch.
- `dnsPolicy: None` with `dnsConfig.nameservers: ["127.0.0.1"]` — **no DNS is
  configured for worker/agent pods at all.** The proxy is reached by name
  (`WARDBY_PROXY_URL=http://wardby-proxy:8787` — `CODING_PROXY_ALIAS` in
  `docker-isolation.ts`, the same alias the Docker launcher uses; this is
  distinct from the `KUBERNETES_PROXY_SERVICE` Kubernetes Service name,
  `wardby-coding-proxy` by default — the proxy checks the `Host` header)
  only because the pod's `hostAliases` maps `wardby-proxy` directly to the
  proxy Service's ClusterIP — closing DNS as an exfiltration channel
  without needing a resolver at all.
- `activeDeadlineSeconds = spec.timeoutSec + POD_DEADLINE_GRACE_SECONDS`
  (300s) — a **backstop only**. The launcher enforces the real wall-clock
  deadline itself (`observePod` in `kubernetes.ts`); the extra 300s exists so
  the keeper survives long enough after the worker's deadline for result
  collection to still succeed. A worker that exits 0 counts as `succeeded`
  only if all three hold: the pod's status reason isn't `DeadlineExceeded`,
  the pod isn't being deleted (`metadata.deletionTimestamp` unset), and the
  terminated container's `finishedAt` is at or before
  `deadlineAt + 5s` (clock-skew slack). This closes off a SIGTERM-trapping
  worker turning a deadline kill into a fake success, while still accepting
  a run that genuinely finished just before its deadline and was only
  observed after it.
- Everything else matches the Docker policy's spirit: uid/gid 10001,
  `runAsNonRoot`, all capabilities dropped, `allowPrivilegeEscalation:
false`, seccomp `RuntimeDefault`, read-only root filesystem, no host
  network/PID/IPC, `automountServiceAccountToken: false`, a dedicated
  no-RBAC service account (`wardby-coding-worker`).

Per-run objects, all labeled `app.kubernetes.io/managed-by: wardby`,
`wardby.io/component: coding-run`, `wardby.io/run-sha256: <sha256(runId)
prefix>`, named `wardby-run-<token>` (`<token>` = first 20 hex chars of
`sha256(runId)`):

- The **pod** and its **NetworkPolicy** (same name).
- A **capability Secret** (`wardby-run-<token>-cap`) holding the run's proxy
  capability, injected only via `secretKeyRef` — never in the pod spec,
  command, or arguments. For a Claude Code run, the same Secret also carries
  a `tool-setup` key (the tool runner's `WARDBY_TOOL_SETUP` JSON), likewise
  injected only via `secretKeyRef`.
- A **record ConfigMap** (also `wardby-run-<token>`) holding all job state —
  phase, deadline, result — updated with optimistic concurrency
  (`resourceVersion`). This replaces local state files and in-process
  timers entirely: any control-plane replica can observe, collect, stop, or
  remove any run, and a restarted process loses nothing.

**Record ConfigMaps are retained as tombstones by design.**
`remove()` deletes the pod, NetworkPolicy, and capability Secret, but
deliberately _rewrites the record to `phase: "removed"` instead of deleting
it_ (`kubernetes.ts`, `remove()`) — the contract is that a removed run is
never relaunched, and the record is what a later `launch()` call for the
same run ID checks. Wardby does not yet garbage-collect old tombstones, so they
accumulate until an operator removes them. **A launch that fails during
provisioning accumulates a record too**,
not just a `remove()`d run's tombstone: the failure path writes `phase:
"failed"` and the executor never calls `remove()` for a launch that threw,
so every failed launch leaves a permanent record as well. On a busy cluster
this is etcd growth to budget for operationally, not a correctness or
security problem — see "Known gaps" below.

**The executor persists a run's job handle before calling `jobs.launch()`,
closing the crash window that would otherwise orphan a running pod.** The
Kubernetes handle (`{ backend: "kubernetes", id: "<namespace>/<token>" }`)
is fully derivable from the run ID alone, with no cluster call, so it can be
(and is) written to the run record before the launcher ever creates
anything. If the control plane crashes or is replaced mid-launch — after the
pod has been attested and the worker gate has opened, but before the old
code path would have recorded the handle — the run's handle is already on
record, so restart reconciliation can find, stop, and clean up the pod,
NetworkPolicy, and capability Secret through the normal `abandon()` path
instead of leaking them permanently.

### Attestation — deny-by-default, fail closed

Before the worker gate ever opens, the launcher reads back the created pod
and NetworkPolicy and compares them against the canonical builder's output
with `assertRunPodMatches` / `assertRunNetworkPolicyMatches`
(`kubernetes-isolation.ts`). This is a **full, canonical, deep comparison of
the entire spec, labels, and annotations** — not an allowlist of fields the
launcher expects to see. An early allowlist-based version of this comparator
was replaced during implementation review specifically because an allowlist
silently accepts anything it forgot to check (lifecycle hooks,
liveness/readiness/startup probes whose `httpGet.host` can reach the node's
link-local metadata endpoint bypassing the NetworkPolicy, `procMount`,
`seLinuxOptions`, extra tolerations, `nodeSelector`, stray annotations, ...).
The only normalization applied before comparing is an explicit, narrow list
of transformations the Kubernetes API server itself is known to perform on
write/read — never a loosening of what's compared:

- Dropping `schedulerName`, `nodeName`, `priority`, `preemptionPolicy` (server-assigned).
- Dropping `hostNetwork`/`hostPID`/`hostIPC` when `false`, and an empty
  NetworkPolicy `ingress: []`, because Go's `omitempty` drops a zero-value
  bool or empty slice on serialization — a real read-back never carries
  these fields at their false/empty value, only when true/non-empty.
- Removing the mirrored `serviceAccount` field when it equals
  `serviceAccountName` (and failing closed if it doesn't).
- Removing exactly the two well-known `NoExecute` node-health tolerations
  (`node.kubernetes.io/not-ready` / `unreachable`, 300s) every pod gets by
  admission-time default — any other toleration must match exactly.
- Dropping container `terminationMessagePath`/`terminationMessagePolicy`/`imagePullPolicy`
  and probe threshold/period defaults, and normalizing CPU/memory quantities
  to a canonical millicore/byte count (so `"1"`, `"1.0"`, and `"1000m"`
  compare equal) — with a non-integer-at-that-scale value mapped to a
  sentinel that can never equal a real value, so quantity drift fails closed
  instead of rounding two different resources together.
- Dropping `mountPropagation: "None"` and an `emptyDir.medium: ""`.

Any other difference — anything not on this list — fails the launch closed
with `kubernetes_isolation_unsupported`. No fallback to a weaker profile.

On top of that, a **platform profile** (`KUBERNETES_PLATFORM`) may forgive a
named, narrow set of mutations its managed admission chain is known to make —
for `gke-autopilot`: annotations under `autopilot.gke.io/` and `dev.gvisor.`,
labels under `autopilot.gke.io/` and `topology.kubernetes.io/`, the gVisor
`nodeSelector`, and two exact tolerations. A profile can only delete named keys
from both operands before the comparison; it can never disable or short-circuit
it, and `generic` (the default, and what an omitted argument selects) forgives
nothing. Most of that list was captured from a real cluster with
`npm run capture:autopilot`, which submits the pod with `dryRun=All`. That
capture has a structural blind spot worth knowing: a dry run is admission only
and never schedules, so anything the platform stamps on **after binding** —
GKE's `topology.kubernetes.io/{region,zone}`, taken from the node the pod
landed on — cannot appear in it. That case reached a live Autopilot launch with
every dry-run-derived check passing, and is now pinned by tests. Treat a
captured fixture as a lower bound on what a platform mutates.

### The enforcement gate

The Kubernetes API can create a NetworkPolicy object without that policy
being enforced yet — CNIs (including `kind`'s default kindnet) program a new
pod's policy a few seconds _after_ the pod starts, not atomically with pod
creation. The delay is observable on real clusters and threatens every run,
not just the harness: the worker gate could otherwise
open on a pod whose isolation isn't active yet.

The fix, before seeding or opening the worker gate: the launcher execs into
the keeper (which shares the pod's network namespace with the worker) a
`node -e` script whose every probe measures **both of the coding proxy's ports
against the proxy Service's ClusterIP, in the same pass** — `8787` (the proxy
itself, which the run policy permits) and `8788` (the deny port, which no run
policy ever permits). Only the outcome **(8787 connected, 8788 blocked)** counts
toward the streak.

Stated exactly, that outcome proves: **the SYN to 8788 was dropped somewhere on
the path, while the same destination answered on 8787.** That the drop was the
_run pod's own egress policy_ does not follow from the measurement alone — it
follows from the proxy admitting run pods on 8788 at its own ingress, so that no
other hop is left to drop it. That precondition used to be asserted by manifest
and checked nowhere, and was falsified on a live cluster: with the proxy's policy
admitting 8787 only, a prober with no policy at all and full internet egress read
**proven**, because the proxy's own ingress dropped the packet. The `proxy-service`
preflight check now reads the proxy's NetworkPolicy and verifies that rule, so the
attribution is checked rather than assumed.

Both halves are required, and measuring only one port would be unsound. A
NetworkPolicy denial **drops** the packet rather than rejecting it — GKE
Dataplane V2 (Cilium), which Autopilot runs, always drops — so "8788 did not
answer" on its own is equally consistent with "the proxy is gone and no policy
exists at all", and a run would be released onto an unpoliced network.
Requiring 8787 to connect in the _same_ exec turns "something is listening"
from a control-plane inference (which is stale the moment it is read) into a
fact this pod just observed, at the instant of the blocked observation. The
proxy's own policy deliberately **allows** ingress on 8788 from run pods:
ingress is enforced at the destination, so denying it there would make a run
pod whose own egress policy was not yet programmed read as "blocked" — which is
precisely the live falsification above, and why that rule is now verified at
preflight instead of trusted.

**"Blocked" means a timeout specifically, not "did not connect".** Pairing the
two ports only rules out "the whole proxy pod is dead"; it does not rule out
the deny _listener_ being unserved while the pod is otherwise healthy. This was
reproduced on a live cluster: in a namespace with no NetworkPolicy at all,
against a pod listening on 8787 and serving nothing on 8788, a probe that
treated any failed connect as "blocked" exited **proven** while it had full
internet egress. No control-plane read closes this — an Endpoints subset port is
the Service's numeric `targetPort`, not evidence that anything is bound — so the
probe distinguishes the two socket outcomes itself: a **timeout** means the
packet was dropped (a policy), while a **refusal** (RST / `ECONNREFUSED`) proves
the SYN reached the destination host, on every dataplane, since a drop cannot
produce an RST. A refused deny port is therefore reachable-but-unserved and is
reported as `kubernetes_policy_witness_unserved`, never as proven.

The intended consequence: on a **reject-style** CNI a genuine policy denial also
arrives as an RST, so such a cluster now fails closed here rather than passing
vacuously. That is the correct direction — a witness that cannot tell "denied"
from "unserved" is not a witness — and such a cluster needs a different one.

It requires **3 consecutive proven results, 500ms apart** (anything else
resets the streak — this guards against a single dropped SYN packet on an
allowed path being misread as "policy enforced"). The whole streak runs in a
single keeper exec: the script exits successfully only after three consecutive
proven probes, and stops at the first probe that is not proven, exiting with
that probe's result. A broken streak is retried from zero 500ms later, bounded
by `enforcementTimeoutMs` (default 30,000ms — configurable via
`KubernetesJobLauncherOptions.enforcementTimeoutMs`; a drop-style CNI can
need close to this whole window). Each probe has a time budget of
`KUBERNETES_ENFORCEMENT_EXEC_TIMEOUT_MS` (default 10,000ms), so one streak exec
is allowed three budgets plus the two 500ms gaps (31,000ms at the default), and
the launcher never lets `enforcementTimeoutMs` fall below that one-streak value
— at the defaults the effective bound is therefore 31,000ms. The bound is
checked between streak execs, so a launch can run past it by up to one streak
exec. An exec that exceeds its timeout fails the launch with
`kubernetes_exec_timeout`. The
verdict at the bound comes from the
_last_ probe — not from whether any probe was ever unavailable, so an early
blip while the pod's networking came up does not misdirect the operator — and
the three non-proven outcomes stay distinct, because each sends an operator
somewhere different:

| Last probe       | Verdict                                 | Where to look                            |
| ---------------- | --------------------------------------- | ---------------------------------------- |
| 8788 connected   | `kubernetes_policy_not_enforced`        | the CNI: no policy, or not port-scoped   |
| 8787 unreachable | `kubernetes_policy_witness_unavailable` | the proxy pod / its Service              |
| 8788 refused     | `kubernetes_policy_witness_unserved`    | the deny listener, or a reject-style CNI |

Any other exit code means the probe never ran to completion (a crash, a missing
interpreter, an OOM-killed keeper), so nothing was measured and nothing about
the policy can be concluded: that is `kubernetes_policy_probe_unusable`, and it
carries the observed exit code. Every one of these messages names the probed
address and the exit code it saw, because an operator reads the error, not this
page.

This wait happens inside the pod's overall ready-timeout window, not on top of
it.

`wardby coding preflight`'s canary pod waits the same way before running its
probes, for the same reason.

### Preflight

`kubernetesPreflight` / `runKubernetesPreflight`
(`src/providers/jobs/kubernetes-preflight.ts`) run **five checks in order**,
each producing `kubernetes_isolation_unsupported:<check>` on failure (or
`:timeout` if the whole preflight — cleanup included — exceeds `timeoutMs`,
default 90,000ms):

1. `platform` — pure configuration, checked before any cluster API call:
   `assertPlatformConfig` (`src/providers/jobs/kubernetes-platform.ts`) refuses
   a deployment that cannot work under `KUBERNETES_PLATFORM`. Under
   `gke-autopilot` this means `KUBERNETES_RUNTIME_CLASS` must be `gvisor`
   (gVisor is mandatory there — an unset or different runtime class is refused,
   not warned about), and the effective `CODING_MAX_DISK_MB` must leave room
   for the worker container's 1 GiB reservation inside Autopilot's 10 GiB pod
   ephemeral-storage ceiling. The same assertion runs again at process
   start-up in `buildConfiguredExecutor`
   (`src/providers/executor/composition.ts`), so an unrunnable configuration
   fails the process immediately rather than waiting for the first coding run
   or the next `wardby coding preflight` invocation to discover it.
2. `namespace` — the configured namespace exists.
3. `proxy-service` — the proxy Service exists, has a ClusterIP, **exposes both
   the proxy port (8787) and the deny port (8788)** over TCP, has at least one
   ready endpoint serving both, **and the proxy's own NetworkPolicy admits
   `wardby.io/component: coding-run` on 8788** — failing closed with
   `kubernetes_isolation_unsupported:proxy-service` otherwise. That last clause
   is the attribution precondition: a dropped connect to 8788 only indicts the
   run pod's own egress policy if no other hop would have dropped it, and
   ingress is enforced at the destination, so without it deleting one line from
   an overlay's proxy policy makes every run read as enforced. The deny port is
   the enforcement witness: a second listener on the proxy
   (`src/providers/coding-proxy/deny-port.ts`) that serves nothing and that no
   run's NetworkPolicy ever permits. A run pod that reaches 8787 but not 8788
   has proven its policy is both programmed and port-scoped. It replaces the old
   `cluster-dns` witness, which does not exist on GKE Autopilot (Cloud DNS is the
   only provider there, so no kube-dns pods run) and which made the launcher read
   `kube-system`.
4. `worker-image` — the canary's image is a registry digest: `CODING_WORKER_IMAGE`,
   or `CODING_CLAUDE_WORKER_IMAGE` on a deployment without a Codex worker.
5. `canary` — creates a real run pod + NetworkPolicy from the same builders
   as a live run, running a script that waits for policy enforcement (as
   above) then attempts DNS resolution, a connect to the proxy's deny port,
   the internet (`1.1.1.1:443`), the metadata server, and the proxy itself —
   requiring every one of the first four to fail and the proxy connect to
   succeed. Any other outcome, or a canary pod that itself fails to
   schedule/run, is `kubernetes_isolation_unsupported:canary`.

This whole preflight is **memoized per launcher instance and its failure is
sticky**: `KubernetesJobLauncher.runPreflight()` caches the first call's
promise (`this.preflightResult ??= ...`, `kubernetes.ts:790`), including
a rejection — so once a launcher process has seen preflight fail, every
subsequent `launch()` in that process fails immediately with the same error
without re-probing the cluster. A fresh preflight requires a new process
(or, from the CLI, a fresh `wardby coding preflight` invocation, which is
not memoized).

**A long-running server process starts this same memoized preflight at
start-up, not on the first coding run.** `wardby serve`, `wardby mcp` (both
transports), and `wardby scheduler` each call `KubernetesJobLauncher.warmUp()`
right after the executor is built, fire-and-forget: it runs the identical
preflight `launch()` would otherwise run lazily, so the first coding run
after a restart doesn't pay the preflight's own cost (a canary pod, routinely
tens of seconds on a resource-constrained cluster such as `kind`).
`wardby scheduler` needs this just as much as the other two — it dispatches
scheduled coding runs through its own Kubernetes executor without ever
starting an MCP server, so without this it would still pay the lazy cost on
its first scheduled run. The result is logged once at start-up — an info
line on success, a warning naming the failure code (e.g.
`kubernetes_isolation_unsupported:<check>`) otherwise.

**A start-up warm-up's failure is logged and retried on the next run, not
left stuck until restart.** This is the one way a preflight failure is
_not_ memoized: a transient cluster problem at process start (the API
server briefly unreachable, a slow CNI not yet programmed, and the like)
must not fail every coding run for the rest of that process's life, so a
failed warm-up clears its own failed attempt once it has logged it, and the
_next_ `launch()` runs the preflight fresh — succeeding if the cluster has
since recovered. A `launch()` that was already waiting on that same
in-flight warm-up attempt still fails with that attempt's error (it shares
the same preflight call), exactly as it always has; it's only the attempt
_after_ that one which retries. A preflight failure `launch()` triggers
itself — because no warm-up ran, or because a warm-up's cleared failure was
never retried before the next `launch()` found the cluster still broken —
keeps the original behavior exactly: it stays memoized, failing every
subsequent `launch()` in that process until it is restarted. This never
runs for a one-shot CLI command (`wardby run`, `wardby coding preflight`,
migrations, imports) — only for a process that stays up to serve or
dispatch runs.

**A hung pod create during preflight can leave a preflight pod and its
NetworkPolicy behind.** If `createPod` never settles (rather than failing),
the preflight's own timeout still fires and the caller sees `:timeout`, but
cleanup for that pod/policy is deferred to whenever the stuck create call
eventually resolves (`tracked`/`lateCleanup` in `kubernetes-preflight.ts`) —
if it never does, the objects are never removed automatically. **A canary
pod and policy are not distinguishable by name from a real run's:** both are
named `wardby-run-<runId's sha256 prefix>` (`kubernetesRunNames`,
`kubernetes-isolation.ts:90-96`, used by the preflight at
`kubernetes-preflight.ts:218,241`) and carry the same
`wardby.io/component: coding-run` label as a live run
(`kubernetes-isolation.ts:98-104,249`) — there is no
`wardby-run-preflight-*` naming pattern. After a `:timeout` failure,
operators should instead list every object with
`wardby.io/component=coding-run` in the namespace and cross-reference
against the run record ConfigMaps that legitimately exist (a stray canary
object has no corresponding non-tombstoned run record, since preflight
never creates one). Giving preflight objects a distinguishing label (e.g.
`wardby.io/component: coding-preflight`) would make this a direct label query;
see "Known limitations" below.

### RBAC actually required

The launcher's `ClientNodeKubernetesApi` issues a narrow, specific set of
calls, and `deploy/kind-coding/manifests/base/` grants exactly that (no
`list`/`watch` on pods, no `get` on secrets — the seam never reads one
back):

- Namespace `Role` **`wardby-coding-launcher`** (in the coding namespace):
  `pods` create/get/delete, `pods/exec` create/get, `pods/log` get,
  `secrets` create/delete, `configmaps` create/get/update, `networkpolicies`
  create/get/delete, `services` get, and `endpoints` get scoped by
  `resourceNames: ["wardby-coding-proxy"]` — the one read `readProxyWitness`
  needs to prove the deny port is exposed with a ready backend. **Nothing in
  `kube-system` any more:** the old `wardby-coding-dns-reader` Role is gone
  with the `cluster-dns` check.
- `ClusterRole` **`wardby-coding-namespace-reader`**: `get` on the
  cluster-scoped `namespaces` resource, `resourceNames: [<the namespace>]`.
  This one has to be cluster-scoped — no namespaced `Role` can grant `get`
  on `namespaces` — but it's still scoped down to the one namespace via
  `resourceNames`, so the launcher identity can't discover any other
  namespace's existence.

(`deploy/kind-coding/` binds none of these to a service account — the local
harness runs every command against your own admin kubeconfig. A production
overlay, e.g. GKE, binds these two to the control plane's identity.)

**Running the real-cluster integration suite needs more than this.**
`npm run test:kubernetes` (`kubernetes.integration.test.ts`) uses a raw
`@kubernetes/client-node` client directly, alongside the launcher's own
`KubernetesApi` seam, for two things outside what the launcher itself ever
does: it reads `Endpoints` objects (`get endpoints`) to resolve kube-dns's
and the proxy pod's addresses for its isolation probes, and its cleanup
deletes each run's record ConfigMap (`delete configmaps`) — the launcher
intentionally never deletes that object (see "kept as tombstones" above), so
`deleteConfigMap` isn't even part of the `KubernetesApi` seam; the test goes
straight to the library. The committed `wardby-coding-launcher` Role grants
neither verb. On `kind` this gap is invisible because the suite runs against
the admin kubeconfig; a kubeconfig scoped to only the two launcher roles
above needs `get endpoints` (coding namespace and `kube-system`) and
`delete configmaps` (coding namespace) added before the integration suite
will pass against it.

### Diagnostics

On a failed run, the launcher reads only the failed worker container's last
8 log lines (bounded to 128 KiB, room for eight full-size
[debug trace](#debug-trace) lines) through the Kubernetes API
(`pods/log`), and keeps only a code matching the existing
`SAFE_WORKER_DIAGNOSTIC` pattern (imported from the Docker launcher) — the
raw text itself is never stored, logged, or returned
(`readWorkerDiagnostic`, `kubernetes.ts`). For `coding_output_invalid`, the
same line may also carry `issues`: up to 8 `path:code` entries (for example
`tag:invalid_string`) naming which output-schema fields failed, never their
values. The list is kept only when every entry matches
`SAFE_CODING_OUTPUT_ISSUE`, and the executor logs it next to the diagnostic id.

### Known limitations

- **No gVisor / per-pod process (PID) limit on `kind`.** `kind` has no
  runtime-class sandboxing; `KUBERNETES_RUNTIME_CLASS` is unset in the local
  harness and the launcher logs `kubernetes_runtime_class_unset` once per
  launch as a loud "development cluster" warning. Use the GKE Autopilot
  overlay with its required `gvisor` runtime class for production.
- **The real-cluster integration coverage is partial.** It covers the contract
  suite against the real API, the enforcement gate, and a full run lifecycle.
  It does not yet cover the isolation acceptance suite's
  OOM/disk-full/wall-clock containment assertions, "canary fails when a
  policy is removed", or Claude Code's tool-runner sidecar (there is no
  separate tool pod: it shares the run pod's network namespace and
  NetworkPolicy with the worker, so the coverage needed is different from a
  second pod's isolation).
- **No end-to-end backpressure or host-side archive-size cap** once the
  exec WebSocket for a seed/collect transfer is connected — pre-existing,
  documented, not a regression of this milestone.
- **An over-ceiling `workspaceDiskMb` fails late and generically** — see
  "Control Plane Configuration" above.
- **Namespace handling must remain explicit in every overlay.**
  `deploy/kind-coding/manifests/base/kustomization.yaml`
  deliberately has **no top-level `namespace:` override**, because
  kustomize's namespace transformer would force `metadata.namespace` onto
  every namespaced resource it lists. Every manifest instead sets its own
  `metadata.namespace` explicitly. Any overlay author copying this harness for
  another cluster must do the same.
- **Per-run record ConfigMap GC is unimplemented.** Both `remove()`'s
  deliberate tombstones and a failed launch's records (see above)
  accumulate, one small ConfigMap per run, with nothing that automatically
  deletes them. Operators need a retention job for a long-lived deployment;
  this is an operational concern rather than a correctness or security issue.
- **Autopilot dry-run capture is a lower bound.** Admission dry runs cannot
  observe topology labels added after pod scheduling. The reviewed platform
  profile and tests include those known labels, but every target cluster must
  still pass preflight before accepting work.
- **A distinguishing label for preflight/canary objects.** Canary pods and
  policies are currently named and labeled identically to real run objects
  (`wardby.io/component: coding-run`), which is why the troubleshooting
  guidance above can only recommend cross-referencing against run records
  rather than a direct label query. Giving preflight objects their own
  `wardby.io/component: coding-preflight` label would fix this and would
  also let a future orphan reaper (the ConfigMap GC item above, extended to
  pods) tell a canary apart from a live run.
- **The real-cluster integration suite still uses the deprecated core/v1
  `Endpoints` API** (`kubernetes.integration.test.ts`) rather than
  `discovery.k8s.io/v1` `EndpointSlice`. `Endpoints` is deprecated, not yet
  removed, and this is test-only code, but the migration is a tracked
  remaining compatibility task.

### Troubleshooting: failure codes

| Code                                                                         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kubernetes_isolation_unsupported:<check>`                                   | A preflight check failed; `<check>` is one of `platform`, `namespace`, `proxy-service`, `worker-image`, `canary`. Sticky for the launcher's process lifetime once seen (see Preflight above).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `kubernetes_isolation_unsupported:timeout`                                   | The whole preflight (including cleanup) exceeded its timeout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `kubernetes_isolation_unsupported`                                           | (No suffix) Attestation failure: the read-back pod or NetworkPolicy didn't canonically match the builder's output.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `kubernetes_policy_not_enforced`                                             | The run's NetworkPolicy wasn't observed enforced (8787 reachable, 8788 blocked) within `enforcementTimeoutMs`; the worker gate was never opened.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `kubernetes_policy_witness_unavailable`                                      | The last enforcement probe could not reach the proxy on 8787 at all, so nothing could be witnessed — the proxy or its Service is the thing to check, not the CNI. The worker gate was never opened.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `kubernetes_policy_witness_unserved`                                         | The last enforcement probe was **refused** (RST) on 8788 rather than dropped. The packet reached the host, so nothing is blocking the path and the witness proves nothing — the deny listener is not serving, or the CNI rejects instead of dropping. Fails closed; the worker gate was never opened.                                                                                                                                                                                                                                                                                                                                                                                        |
| `kubernetes_proxy_witness_unusable: <reason>`                                | The proxy Service is not a usable enforcement witness (missing, no ClusterIP, a required port not exposed as TCP, or no ready endpoint serving both 8787 and 8788). Seen **unwrapped** like this from `provision`'s per-launch re-read, which runs after an earlier witness check already passed -- a supplied `preflight`, or this launcher's own memoized read, the likelier production sighting being a proxy that degrades after that read succeeded; the launcher's own memoized read reports the same condition wrapped as `kubernetes_isolation_unsupported` (with this string on `cause`), and the preflight reports it as `:proxy-service`. Fails closed before the pod is created. |
| `kubernetes_pod_start_timeout`                                               | The keeper didn't become ready within `readyTimeoutMs` (default 120s). Historically caused by the subPath root-ownership issue the `storage-init` init container now fixes; if seen again, check init-container status first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `kubernetes_pod_start_failed`                                                | The pod (or its `storage-init` init container) failed outright rather than timing out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `kubernetes_tool_runner_failed`                                              | (Claude Code only) The tool runner sidecar restarted, exited, or its image could not be pulled before the keeper started. A malformed `WARDBY_TOOL_SETUP` makes the tool runner exit before it is ready (`tool_setup_invalid` in its log), which surfaces as this code on Kubernetes and as `docker_tool_runner_not_ready` on Docker.                                                                                                                                                                                                                                                                                                                                                        |
| `kubernetes_tool_runner_unready`                                             | (Claude Code only) The tool runner sidecar never started (its socket startup probe never passed) by the pod-start bound (`readyTimeoutMs`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `worker_tool_runner_failed`                                                  | (Claude Code only; also seen on the Docker launcher) The tool runner died mid-run, after the pod/containers started successfully.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `worker_tool_runner_unreachable`                                             | (Claude Code only; both launchers) The Claude worker could not connect to the tool runner's socket before calling the model, or Claude Code reported its command tool as not connected. On Kubernetes, check that the pod has the `tool-socket` volume mounted in both the `worker` and `tool-runner` containers.                                                                                                                                                                                                                                                                                                                                                                            |
| `claude_tool_setup_too_large`                                                | (Claude Code only) The run's tool-runner setup (registry settings plus every service test variable) would exceed the tool runner's bounds (1024 variables, 4096 bytes per value, 96 KiB in total), so the launch fails before the tool runner is created.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `kubernetes_isolation_unsupported:tool-image-not-registry-digest`            | (Claude Code only) `CODING_CLAUDE_TOOL_RUNNER_IMAGE` isn't a registry digest. Checked on every launch, not only preflight.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `kubernetes_isolation_unsupported:claude-limits-too-small`                   | (Claude Code only) The run's `cpus`/`memoryMb` are too small to leave the tool runner its fixed floor: Claude Code needs `cpus ≥ 0.35` and `memoryMb ≥ 256`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `kubernetes_seed_failed`                                                     | Streaming the workspace or input artifact into the keeper failed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `kubernetes_workspace_archive_failed` / `kubernetes_result_artifact_invalid` | Collection (workspace or output artifact) failed or was invalid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `coding_workspace_disk_exceeds_limit`                                        | The run's `workspaceDiskMb` exceeds `CODING_MAX_DISK_MB`; surfaces on the run record as `coding_failure_workspace:<id>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `coding_service_unready:<name>`                                              | A service sidecar restarted after its startup probe gave up, could not be pulled or started, or had not started when `readyTimeoutMs` ran out. The run fails with category `service_unready`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Local harness

`deploy/kind-coding/` stands up a local `kind` cluster (with a local image
registry so images are pulled by digest, as on GKE) that proves this
launcher end to end, including real NetworkPolicy enforcement. See
[`deploy/kind-coding/README.md`](../deploy/kind-coding/README.md) for
prerequisites, the up/down scripts, and what each step does.

## Verification

Build the image and run the destructive, self-cleaning acceptance suite:

```sh
docker build -f src/coding-worker/Dockerfile -t wardby-coding-worker:task8 .
npm run test:docker-isolation
npm run verify:claude-code
```

Set `WARDBY_WORKER_IMAGE` to test another local tag. The runner resolves that
tag to an immutable image ID before testing. The suite verifies effective
Docker inspection, no default route, proxy-only connectivity, denied
Docker-socket/host/metadata/localhost/public access, read-only mounts and
rootfs, zero effective capabilities, seccomp and no-new-privileges, private PID
1, PID exhaustion, OOM containment, disk ENOSPC, and wall-clock termination.

Related Docker references:

- Internal and isolated bridge networks: https://docs.docker.com/reference/cli/docker/network/create/
- CPU, memory, swap, and PID controls: https://docs.docker.com/engine/containers/resource_constraints/
- Seccomp and no-new-privileges: https://docs.docker.com/reference/cli/docker/container/run/
- Tmpfs behavior and limits: https://docs.docker.com/engine/storage/tmpfs/
- Volume subpaths and `nocopy`: https://docs.docker.com/engine/storage/volumes/
