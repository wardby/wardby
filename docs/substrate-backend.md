# Substrate job launcher (experimental)

> **Experimental.** `JOB_LAUNCHER=substrate` is an opt-in backend with a narrower
> feature set than the Docker and Kubernetes launchers (see
> [What is not supported](#what-is-not-supported)). Its configuration and
> behaviour may change between releases. Use `docker` or `kubernetes` for
> anything that needs the missing features.

The Substrate backend runs each Claude Code coding run as two actors on
[Agent Substrate](https://github.com/agent-substrate) (version 1.0 or later), a
Kubernetes add-on that runs sandboxed actors under gVisor:

- the **agent actor** runs the Claude Code worker;
- the **tool actor** runs the credential-free tool runner (the commands and the
  `wardby_tools` MCP server).

Neither actor holds a Wardby secret. The run capability is kept in a
per-run Kubernetes Secret that Substrate's egress gateway reads, and the gateway
adds it to the agent's requests on the way to the coding proxy; the tool actor
authenticates with a short-lived actor token the gateway injects. The only
network destination either actor is allowed is the coding proxy. The agent and
the tool runner cannot reach each other directly: the proxy relays their tool
traffic, and moves the workspace seed, the result, the transcript and the
collected workspace through a blob store, because Substrate offers no `exec`
into an actor.

See [Local coding-agent setup](coding-agent-setup.md) for choosing between the
launchers, and [Coding-worker isolation](coding-worker-isolation.md) for the
Docker and Kubernetes ones.

## Requirements

- Kubernetes with **Agent Substrate 1.0 or later** installed, with:
  - a **gVisor `WorkerPool`** with room for two actors per concurrent coding run;
  - the Substrate **credential provider**, granted read access to the namespace
    that holds Wardby's per-run Secrets (`SUBSTRATE_CREDENTIALS_NAMESPACE`) for
    the atespace Wardby uses;
  - the Substrate **router** and **egress gateway**, with the coding proxy's
    hostname reachable as an egress destination.
- On Google Cloud, use **GKE Standard**, not Autopilot: Substrate's worker nodes
  are not supported on Autopilot.
- The Wardby coding proxy deployed in the cluster (with a database connection:
  the relay keeps its state in Postgres), reachable from the actors at a
  hostname you choose (`SUBSTRATE_PROXY_HOST`).
- **The coding proxy trusts Substrate's internal CA.** The proxy verifies the
  tool actor's token against the signing keys of Substrate's identity provider,
  which it fetches over TLS signed by Substrate's internal CA. Mount the CA
  bundle from the `servicedns.podcert.ate.dev` ClusterTrustBundle into the
  proxy (for example through a projected volume with a `clusterTrustBundle`
  source) and set `NODE_EXTRA_CA_CERTS` on the proxy to that file. Without it,
  every tool request is refused.
- **One blob store shared by the control plane and the proxy** (`BLOB_STORE` and
  its settings, see [Local coding-agent setup](coding-agent-setup.md)). Without
  it the control plane refuses to start with `JOB_LAUNCHER=substrate`, and so
  does a proxy with `SUBSTRATE_ATESPACE` set.
- A Substrate API token with the audience `api.ate-system.svc`: a Kubernetes
  ServiceAccount token created for that audience (for example with
  `kubectl create token <service-account> --audience api.ate-system.svc`, or a
  projected `serviceAccountToken` volume), mounted as a file for the control
  plane and refreshed by your platform. A token with another audience is
  refused by the Substrate API.
- **Agent and tool images that run the Substrate bridge.** The agent actor uses
  `CODING_CLAUDE_WORKER_IMAGE` and the tool actor `CODING_CLAUDE_TOOL_RUNNER_IMAGE`
  (and the per-toolchain tool-runner images), each as a registry digest
  (`repo@sha256:<64 hex>`), as for the Kubernetes launcher. For Substrate these
  must be the worker and tool-runner images with the bridge added as the
  entrypoint: build `src/substrate-bridge/Dockerfile.agent` on the Claude Code
  worker image and `src/substrate-bridge/Dockerfile.tool` on the tool-runner
  image (`--build-arg BASE=<image>`, build context the repository root, after
  `npm run build`), push both, and pin the resulting digests. `CODING_WORKER_IMAGE`
  (Codex) is not used by this backend.

## Configure

Set `JOB_LAUNCHER=substrate` on the control plane and set the same
`SUBSTRATE_ATESPACE`, `SUBSTRATE_PROXY_HOST` and `SUBSTRATE_PROXY_PORT` on the
coding proxy; the proxy serves the Substrate routes only when
`SUBSTRATE_ATESPACE` is set. Both processes read `BLOB_STORE`.

### Control plane

| Variable                          | Required | Default              | Purpose                                                                                                                             |
| --------------------------------- | -------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `JOB_LAUNCHER`                    | Yes      | `local`              | Set to `substrate`.                                                                                                                 |
| `SUBSTRATE_API_URL`               | Yes      |                      | Substrate Control API URL (a valid URL).                                                                                            |
| `SUBSTRATE_TOKEN_FILE`            | Yes      |                      | File holding the Substrate API token (audience `api.ate-system.svc`). Read on each call, so a refreshed token is picked up.         |
| `SUBSTRATE_ATESPACE`              | Yes      |                      | The Substrate atespace the run actors live in (a DNS label). No default; the proxy must use the same value.                         |
| `SUBSTRATE_PROXY_HOST`            | Yes      |                      | Hostname the actors use to reach the coding proxy. It is also the egress destination Wardby allows each actor.                      |
| `SUBSTRATE_PROXY_PORT`            |          | `8787`               | Port of the coding proxy as the actors reach it (1 to 65535). Set the same value on the proxy.                                      |
| `SUBSTRATE_CREDENTIALS_NAMESPACE` |          | `wardby-run-secrets` | Namespace where Wardby creates the per-run Secret. The credential provider must be granted read access to it for the atespace.      |
| `SUBSTRATE_KUBE_CONTEXT`          |          | default context      | Kubernetes context used to create and delete the per-run Secrets.                                                                   |
| `SUBSTRATE_CA_FILE`               |          | system trust         | CA bundle that verifies the Substrate API's certificate.                                                                            |
| `SUBSTRATE_SERVER_NAME`           |          | from the URL         | TLS server name to verify, when it differs from the host in `SUBSTRATE_API_URL`.                                                    |
| `SUBSTRATE_WORKER_SELECTOR`       |          | any worker           | Comma-separated `key=value` worker labels; only matching workers count for capacity.                                                |
| `SUBSTRATE_STARTUP_TIMEOUT_SEC`   |          | `300`                | How long the actors may take to reach the coding proxy before the run fails (30 to 7200).                                           |
| `SUBSTRATE_COLLECT_GRACE_SEC`     |          | `120`                | After the worker exits without a result, how long the tool side may take to report the workspace before the run fails (10 to 3600). |
| `BLOB_STORE` and its settings     | Yes      |                      | The blob store shared with the proxy. See [Local coding-agent setup](coding-agent-setup.md).                                        |

The digest requirement for the worker and tool-runner images is the same as for
`JOB_LAUNCHER=kubernetes`; the control plane refuses to start without digests.

### Coding proxy

| Variable                      | Required       | Default                   | Purpose                                                                                                                                                                                                     |
| ----------------------------- | -------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUBSTRATE_ATESPACE`          | To turn it on  | unset (routes off)        | Enables the Substrate routes. Must equal the control plane's value.                                                                                                                                         |
| `SUBSTRATE_PROXY_HOST`        | When routes on |                           | Bare hostname (no scheme, port or path) the actors use; the proxy accepts it as a `Host`.                                                                                                                   |
| `SUBSTRATE_PROXY_PORT`        |                | `8787`                    | The port the actors use, as on the control plane; the proxy accepts `<host>:<port>` (and the bare host on port 80) as a `Host`. Required when it is not 8787.                                               |
| `SUBSTRATE_ACTOR_JWT_ISSUER`  | When routes on |                           | Issuer of the actor tokens Substrate mints for the tool actor: Substrate's own identity provider (for example `https://idp.ate-system.svc` in a default install), not the cluster's service-account issuer. |
| `NODE_EXTRA_CA_CERTS`         | When routes on |                           | File with Substrate's internal CA bundle (from the `servicedns.podcert.ate.dev` ClusterTrustBundle), so the proxy can fetch the issuer's signing keys over TLS.                                             |
| `SUBSTRATE_ACTOR_JWKS_URL`    |                | `<issuer>/openid/v1/jwks` | Where the proxy fetches the issuer's signing keys, when they are not at the default path.                                                                                                                   |
| `SUBSTRATE_RESULT_MAX_MB`     |                | `16`                      | Largest result a run may upload.                                                                                                                                                                            |
| `SUBSTRATE_TRANSCRIPT_MAX_MB` |                | `64`                      | Largest session transcript a run may upload.                                                                                                                                                                |
| `SUBSTRATE_WORKSPACE_MAX_MB`  |                | `1024`                    | Largest collected workspace a run may upload. See [Git history](#git-history).                                                                                                                              |
| `BLOB_STORE` and its settings | When routes on |                           | The same blob store as the control plane.                                                                                                                                                                   |

The proxy refuses to start when `SUBSTRATE_ATESPACE` is set and a required
variable is missing, and the error names the variable, never a value. An upload
must arrive within ten minutes of being authenticated.

## What is supported

- Claude Code coding runs, including the package registry (npm and PyPI through
  the proxy), session transcripts (so a run can be resumed), run steps, stop,
  run deadlines and turn limits.
- `codingProfile.gitHistory` runs (see [Git history](#git-history)).
- Capacity: a run that cannot be placed because the WorkerPool has no room
  waits in the queue and is retried, like a quota refusal on Kubernetes.

### Git history

A `gitHistory` run is supported. The run's whole `.git` is uploaded with the
workspace when the run ends, so `SUBSTRATE_WORKSPACE_MAX_MB` on the proxy must be
large enough for the repository's history as well as its files. The proxy
refuses a workspace upload over the limit, and the run fails with
[`substrate_collect_failed`](../help/errors/substrate-collect-failed.md). The
collected archive's entries count toward the extraction limit of 100,000
entries, the `.git` ones included. See
[Git history in coding runs](../help/git-history.md).

## Warm rounds

By default every round of a coding run (a continuation made with
`trigger_agent`'s `continuePriorRun`, a lead's follow-up, a review fix round)
starts new actors and a new workspace. With `SUBSTRATE_WARM_ROUNDS=true`, a
finished round's two actors are suspended and kept, and the next round of the
same chain resumes them: the workspace (including installed packages and build
output) and the Claude session are still there, so the round skips the checkout
and install and continues the conversation. See
[Warm rounds on Substrate](../help/substrate-warm-rounds.md).

A round is kept only when it is a Claude Code run that succeeded, its push
succeeded and pushed changes (a round with no changes is not kept), and its
session was cancelled (its credentials revoked). Any other
round is removed, as without warm rounds. Rounds with git history (an agent
with `codingProfile.gitHistory` set) always start fresh: Wardby rewrites
the agent's commits before it pushes them, so a kept workspace's history would
not match the pushed branch.

### Turn it on

Set `SUBSTRATE_WARM_ROUNDS=true` on **both** the control plane and the coding
proxy, with the same value, and restart both. With it on only for the control
plane, a follow-up round waits for the proxy and then fails with the
[startup timeout](../help/errors/substrate-startup-timeout.md). With it on only
for the proxy, rounds simply start fresh.

| Variable                 | Where                   | Default | Purpose                                                                                      |
| ------------------------ | ----------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `SUBSTRATE_WARM_ROUNDS`  | Control plane and proxy | `false` | `true` keeps a succeeded round's actors for the next round. Must match on both.              |
| `SUBSTRATE_PARK_TTL_SEC` | Control plane           | `3600`  | How long a kept round may wait for its next round (60 to 86400 seconds), then it is removed. |
| `SUBSTRATE_PARK_MAX`     | Control plane           | `10`    | The most rounds kept at once (0 to 1000). `0` keeps none, so every round starts fresh.       |

Also:

- The **Substrate ServiceAccount** Wardby's API token belongs to needs
  permission for `SuspendActor` (besides the calls it already needs). Without
  it, a finished round cannot be kept and the next round starts fresh.
- The actor **templates change name** when warm rounds are on, so the first run
  after you turn it on rebuilds the golden snapshots, as after any template
  change. Turning it off again changes them back.
- **Turning it off** removes every kept round when the control plane next
  starts (and on its regular sweep), expired or not, with all of each run's
  per-round files. Nothing is kept or resumed while it is off.

### When a round starts fresh

A continuation that cannot resume the kept round starts a normal fresh round
and writes one run step line saying why (`get_run` shows `warmStart: true` or
`false` on the round):

| Step line                                                                        | Meaning                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Resumed the previous round's workspace and session                               | The round resumed warm.                                            |
| Started a fresh workspace: the previous round was not kept                       | It did not qualify, or was removed (see below).                    |
| Started a fresh workspace: the previous round's sandbox expired                  | `SUBSTRATE_PARK_TTL_SEC` passed.                                   |
| Started a fresh workspace: the branch changed since the previous round           | The branch has commits the kept workspace lacks.                   |
| Started a fresh workspace: the agent's settings changed since the previous round | The agent's model, prompt, images or limits changed.               |
| Started a fresh workspace: the previous round's sandbox was no longer available  | The actors were gone from Substrate or not in the suspended state. |
| Started a fresh workspace: there was no room to resume the previous round        | The WorkerPool had no capacity to resume it.                       |

A round whose branch preparation merged the target branch into the working
branch (a pull request whose base moved) also starts fresh, because the kept
workspace lacks that merge; it writes no step line.

### What is kept and what is removed

- **Kept:** the workspace, including installed packages, and the Claude
  session.
- **Not kept:** background processes (the tool runner restarts for each round,
  so a dev server or watcher started by one round is gone in the next) and
  credentials (the round's run capability is revoked when it ends; the next
  round gets a new one).
- `stop_run` removes all of that agent's kept rounds.
- `update_agent` removes them when it changes any setting the round was
  launched with (provider, model, prompt, repository, toolchain, images, limits
  or disk). `delete_agent` removes them too.
- A kept round is removed when `SUBSTRATE_PARK_TTL_SEC` passes.
- When more than `SUBSTRATE_PARK_MAX` rounds are kept, the oldest is removed.
- When the WorkerPool is short of room, kept rounds are removed oldest first,
  stopping once a removal frees no room, and never the one being continued.

### Storage cost

A kept round costs snapshot storage in Substrate until it expires or is
removed. It does not reserve worker capacity. Size `SUBSTRATE_PARK_MAX` and
`SUBSTRATE_PARK_TTL_SEC` against your storage budget: keep the TTL short if
rounds rarely follow each other, and use `SUBSTRATE_PARK_MAX=0` to turn keeping
off without turning warm rounds off. If your Substrate deployment counts
suspended actors against worker capacity, kept rounds are removed oldest first
when the WorkerPool is short of room (see above).

### Diagnostics

The proxy's `substrate.diagnostics` warn line carries a `round` field on rounds
after the first, so a tail can be matched to its round.

## What is not supported

A run that needs one of these fails at launch with
[`substrate_feature_unsupported`](../help/errors/substrate-feature-unsupported.md).
Use the Docker or Kubernetes launcher for them.

- Codex agents (Claude Code only).
- Coding services (`.wardby/services.yaml`).
- MCP tools attached to the coding agent.
- The run dependency cache.
- Extra repositories (multi-repository runs).
- A custom worker image (`codingProfile.workerImageRef`): it has no Substrate
  bridge. Only the configured tool-runner images run, so a run dispatched with
  a tool-runner image you have since replaced is refused the same way.
- Suspend and resume between rounds is off by default: every round starts new
  actors, as on the other launchers. Turn it on with
  [warm rounds](#warm-rounds).

## Troubleshooting

A run's persisted error is an opaque failure code with a diagnostic id; the
reason is in the control plane's log under that id. The help articles for each
reason are below. Start with:

1. **Control plane log.** Search for the run's diagnostic id
   (`coding_diag_...`). The reason names the cause, such as
   `job_substrate_startup_timeout`.
2. **Coding proxy log.** When the worker fails, the proxy logs a bounded tail of
   the agent bridge's error output (`substrate.diagnostics`, at warn level, in
   the operator log only). The proxy redacts it by exact value against the
   run's capability and registry-only token before logging it, and never stores
   it or shows it in a run record. The tool bridge sends no tail (the tool actor
   runs the agent's commands); its output stays in the tool actor. The proxy's
   route log (`substrate.route`) shows every actor request with its status.
3. **The Substrate components.** `kubectl logs` for the API server, router,
   credential provider and egress gateway in the Substrate namespace.

Known recovery steps:

- **The credential provider does not see a grant.** After you grant it read
  access to the credentials namespace, restart the credential provider so it
  picks the grant up. Until then runs fail to start.
- **The egress gateway after a Substrate API-server outage.** If the API server
  was unavailable, restart the egress gateway; it can stay unable to apply
  egress policies until restarted.
- **Every run fails at launch.** Check the token audience, `SUBSTRATE_API_URL`,
  `SUBSTRATE_CA_FILE` and `SUBSTRATE_SERVER_NAME`; see
  [`substrate_unavailable`](../help/errors/substrate-unavailable.md).

- **Every tool request answers 401.** `SUBSTRATE_ACTOR_JWT_ISSUER` is not
  Substrate's identity provider, or the proxy cannot fetch its signing keys
  because it does not trust Substrate's CA (`NODE_EXTRA_CA_CERTS`). Runs then
  fail with `substrate_startup_timeout`.
- **Every continuation starts fresh with warm rounds on.** Check that the
  Substrate ServiceAccount may call `SuspendActor`, that
  `SUBSTRATE_PARK_MAX` is above 0, and the step line's reason.
- **Every actor request answers `invalid_host`.** `SUBSTRATE_PROXY_HOST` or
  `SUBSTRATE_PROXY_PORT` differs between the control plane and the proxy.

Error articles: [`substrate_unavailable`](../help/errors/substrate-unavailable.md),
[`substrate_capacity`](../help/errors/substrate-capacity.md),
[`substrate_provisioning_failed`](../help/errors/substrate-provisioning-failed.md),
[`substrate_startup_timeout`](../help/errors/substrate-startup-timeout.md),
[`substrate_collect_timeout`](../help/errors/substrate-collect-timeout.md),
[`substrate_collect_failed`](../help/errors/substrate-collect-failed.md),
[`substrate_result_missing`](../help/errors/substrate-result-missing.md),
[`substrate_feature_unsupported`](../help/errors/substrate-feature-unsupported.md),
[`substrate_image_not_digest`](../help/errors/substrate-image-not-digest.md),
[`substrate_seed_too_large`](../help/errors/substrate-seed-too-large.md),
[`substrate_limits_too_small`](../help/errors/substrate-limits-too-small.md).
