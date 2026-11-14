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
`SUBSTRATE_ATESPACE` and `SUBSTRATE_PROXY_HOST` on the coding proxy; the proxy
serves the Substrate routes only when `SUBSTRATE_ATESPACE` is set. Both
processes read `BLOB_STORE`.

### Control plane

| Variable                          | Required | Default               | Purpose                                                                                                                        |
| --------------------------------- | -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `JOB_LAUNCHER`                    | Yes      | `local`               | Set to `substrate`.                                                                                                            |
| `SUBSTRATE_API_URL`               | Yes      |                       | Substrate Control API URL (a valid URL).                                                                                       |
| `SUBSTRATE_TOKEN_FILE`            | Yes      |                       | File holding the Substrate API token (audience `api.ate-system.svc`). Read on each call, so a refreshed token is picked up.    |
| `SUBSTRATE_ATESPACE`              | Yes      |                       | The Substrate atespace the run actors live in (a DNS label). No default; the proxy must use the same value.                    |
| `SUBSTRATE_PROXY_HOST`            | Yes      |                       | Hostname the actors use to reach the coding proxy. It is also the egress destination Wardby allows each actor.                 |
| `SUBSTRATE_PROXY_PORT`            |          | the coding proxy port | Port of the coding proxy as the actors reach it (1 to 65535).                                                                  |
| `SUBSTRATE_CREDENTIALS_NAMESPACE` |          | `wardby-run-secrets`  | Namespace where Wardby creates the per-run Secret. The credential provider must be granted read access to it for the atespace. |
| `SUBSTRATE_KUBE_CONTEXT`          |          | default context       | Kubernetes context used to create and delete the per-run Secrets.                                                              |
| `SUBSTRATE_CA_FILE`               |          | system trust          | CA bundle that verifies the Substrate API's certificate.                                                                       |
| `SUBSTRATE_SERVER_NAME`           |          | from the URL          | TLS server name to verify, when it differs from the host in `SUBSTRATE_API_URL`.                                               |
| `SUBSTRATE_WORKER_SELECTOR`       |          | any worker            | Comma-separated `key=value` worker labels; only matching workers count for capacity.                                           |
| `SUBSTRATE_STARTUP_TIMEOUT_SEC`   |          | `300`                 | How long the actors may take to reach the coding proxy before the run fails (30 to 7200).                                      |
| `SUBSTRATE_COLLECT_GRACE_SEC`     |          | `120`                 | After the agent finishes, how long the tool side may take to report the workspace before the run fails (10 to 3600).           |
| `BLOB_STORE` and its settings     | Yes      |                       | The blob store shared with the proxy. See [Local coding-agent setup](coding-agent-setup.md).                                   |

The digest requirement for the worker and tool-runner images is the same as for
`JOB_LAUNCHER=kubernetes`; the control plane refuses to start without digests.

### Coding proxy

| Variable                      | Required       | Default                   | Purpose                                                                                                   |
| ----------------------------- | -------------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `SUBSTRATE_ATESPACE`          | To turn it on  | unset (routes off)        | Enables the Substrate routes. Must equal the control plane's value.                                       |
| `SUBSTRATE_PROXY_HOST`        | When routes on |                           | Bare hostname (no scheme, port or path) the actors use; the proxy accepts it as a `Host`.                 |
| `SUBSTRATE_ACTOR_JWT_ISSUER`  | When routes on |                           | Issuer of the actor tokens Substrate mints for the tool actor (the cluster's service-account issuer URL). |
| `SUBSTRATE_ACTOR_JWKS_URL`    |                | `<issuer>/openid/v1/jwks` | Where the proxy fetches the issuer's signing keys, when they are not at the default path.                 |
| `SUBSTRATE_RESULT_MAX_MB`     |                | `16`                      | Largest result a run may upload.                                                                          |
| `SUBSTRATE_TRANSCRIPT_MAX_MB` |                | `64`                      | Largest session transcript a run may upload.                                                              |
| `SUBSTRATE_WORKSPACE_MAX_MB`  |                | `1024`                    | Largest collected workspace a run may upload. See [Git history](#git-history).                            |
| `BLOB_STORE` and its settings | When routes on |                           | The same blob store as the control plane.                                                                 |

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
large enough for the repository's history as well as its files. The proxy refuses a workspace
upload over the limit, so a run whose workspace is larger never collects. See
[Git history in coding runs](../help/git-history.md).

## What is not supported

A run that needs one of these fails at launch with
[`substrate_feature_unsupported`](../help/errors/substrate-feature-unsupported.md).
Use the Docker or Kubernetes launcher for them.

- Codex agents (Claude Code only).
- Coding services (`.wardby/services.yaml`).
- MCP tools attached to the coding agent.
- The run dependency cache.
- Extra repositories (multi-repository runs).
- Suspend and resume between rounds: every round starts new actors, as on the
  other launchers.

## Troubleshooting

A run's persisted error is an opaque failure code with a diagnostic id; the
reason is in the control plane's log under that id. The help articles for each
reason are below. Start with:

1. **Control plane log.** Search for the run's diagnostic id
   (`coding_diag_...`). The reason names the cause, such as
   `job_substrate_startup_timeout`.
2. **Coding proxy log.** When a worker or tool bridge exits early, the proxy logs
   a bounded tail of its error output (`substrate.diagnostics`, at warn level, in
   the operator log only). The tail is redacted by exact value before it leaves
   the actor and is never stored or shown in a run record.
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

Error articles: [`substrate_unavailable`](../help/errors/substrate-unavailable.md),
[`substrate_capacity`](../help/errors/substrate-capacity.md),
[`substrate_startup_timeout`](../help/errors/substrate-startup-timeout.md),
[`substrate_collect_timeout`](../help/errors/substrate-collect-timeout.md),
[`substrate_feature_unsupported`](../help/errors/substrate-feature-unsupported.md).
