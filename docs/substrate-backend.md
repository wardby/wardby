# Substrate job launcher (experimental)

> **Experimental.** `JOB_LAUNCHER=substrate` is an opt-in backend with a narrower
> feature set than the Docker and Kubernetes launchers (see
> [What is not supported](#what-is-not-supported)). Its configuration and
> behaviour may change between releases. Use `docker` or `kubernetes` for
> anything that needs the missing features.

The Substrate backend runs each Claude Code coding run as two actors on
[Agent Substrate](https://github.com/agent-substrate) (version 1.0 or later), a
Kubernetes add-on that runs sandboxed actors under gVisor. A Codex coding run
is a single actor instead (see [Codex runs](#codex-runs)).

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
  must be the worker and tool-runner images with the bridge added. Every actor
  template sets the bridge's command itself, so an image's own `ENTRYPOINT` and
  `CMD` are not used. For Codex agents, `CODING_WORKER_IMAGE` (and
  `CODING_WORKER_IMAGE_NODE_PYTHON_3_12` for the Node + Python toolchain) must
  be the Substrate Codex bridge images, by digest. See [Images](#images).
- **A coding proxy of this release or later** before Codex runs are sent: the
  proxy accepts the `x-api-key` header on the Responses route only when no
  `Authorization` header is present, and serves the routes the Codex actor
  uses to hold the workspace. An older proxy refuses those requests.
- **This release's migrations**, applied with `prisma migrate deploy`
  (`npm run prisma:migrate`) before the new coding proxy and control plane
  start. Upgrade in this order:
  1. Apply `20261121000000_substrate_codex_shape`,
     `20261122000000_substrate_repositories`,
     `20261123000000_substrate_templates`,
     `20261124000000_substrate_services`,
     `20261126000000_coding_service_substrate_image` and
     `20261127000000_builtin_service_setup_done`. The new proxy reads the
     `repositories` and `services` columns on every Substrate request, with or
     without extra repositories or services, so a proxy started before they
     exist fails every run.
  2. Start the new coding proxy.
  3. Start the new control plane.
- **Bridge images, custom images and the proxy from the same release.** Every
  bridge request names its protocol, and the coding proxy refuses a bridge of
  another protocol, failing the run with
  [`substrate_bridge_incompatible`](../help/errors/substrate-bridge-incompatible.md).
  So:
  - upgrade with no Substrate run in flight: a run that started on the older
    bridge images fails that way once the new proxy serves it;
  - update the bridge-image variables (see [Images](#images)) at the same time,
    and rebuild every [custom image](#custom-images) on the new release's
    bridge.

### Images

Releases publish the bridge images to the GitHub Container Registry, each built
on that release's Claude Code worker or tool-runner image. The digest-pinned
reference for the installed version is listed in `dist/quickstart-images.json`
inside the npm package; use each one as-is:

| Variable                                           | Key in `dist/quickstart-images.json` | Image                                |
| -------------------------------------------------- | ------------------------------------ | ------------------------------------ |
| `CODING_CLAUDE_WORKER_IMAGE`                       | `substrateAgent`                     | `wardby-substrate-agent`             |
| `CODING_CLAUDE_TOOL_RUNNER_IMAGE`                  | `substrateTool`                      | `wardby-substrate-tool`              |
| `CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12` | `substrateToolNodePython`            | `wardby-substrate-tool-node-python`  |
| `CODING_WORKER_IMAGE`                              | `substrateCodex`                     | `wardby-substrate-codex`             |
| `CODING_WORKER_IMAGE_NODE_PYTHON_3_12`             | `substrateCodexNodePython`           | `wardby-substrate-codex-node-python` |

```dotenv
CODING_CLAUDE_WORKER_IMAGE=ghcr.io/your-org/wardby-substrate-agent@sha256:replace-with-digest
CODING_CLAUDE_TOOL_RUNNER_IMAGE=ghcr.io/your-org/wardby-substrate-tool@sha256:replace-with-digest
```

Use the bridge images from the same release as the control plane and coding
proxy, so the bridge and the proxy's Substrate routes match. A release before
these images existed has none of the keys; build your own as below.

To use your own worker or tool-runner image, or a build from a checkout, add
the bridge yourself: build `src/substrate-bridge/Dockerfile.agent` on the
Claude Code worker image and `src/substrate-bridge/Dockerfile.tool` on each
tool-runner image (`--build-arg BASE=<repo>@sha256:<digest>`, build context the
repository root, after `npm run build`). For Codex, build
`src/substrate-bridge/Dockerfile.codex` on the Codex worker image the same way
(`docker build -f src/substrate-bridge/Dockerfile.codex --build-arg BASE=<worker>@sha256:… .`).
Push them to a registry the cluster
can pull from, and pin the resulting digests. For an agent's custom image
(`workerImageRef`), see [Custom images](#custom-images).

## Configure

Set `JOB_LAUNCHER=substrate` on the control plane and set the same
`SUBSTRATE_ATESPACE`, `SUBSTRATE_PROXY_HOST` and `SUBSTRATE_PROXY_PORT` on the
coding proxy; the proxy serves the Substrate routes only when
`SUBSTRATE_ATESPACE` is set. Both processes read `BLOB_STORE`.

### Control plane

| Variable                          | Required | Default              | Purpose                                                                                                                                                                                                                                                                |
| --------------------------------- | -------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JOB_LAUNCHER`                    | Yes      | `local`              | Set to `substrate`.                                                                                                                                                                                                                                                    |
| `SUBSTRATE_API_URL`               | Yes      |                      | Substrate Control API URL (a valid URL).                                                                                                                                                                                                                               |
| `SUBSTRATE_TOKEN_FILE`            | Yes      |                      | File holding the Substrate API token (audience `api.ate-system.svc`). Read on each call, so a refreshed token is picked up.                                                                                                                                            |
| `SUBSTRATE_ATESPACE`              | Yes      |                      | The Substrate atespace the run actors live in (a DNS label). No default; the proxy must use the same value.                                                                                                                                                            |
| `SUBSTRATE_PROXY_HOST`            | Yes      |                      | Hostname the actors use to reach the coding proxy. It is also the egress destination Wardby allows each actor.                                                                                                                                                         |
| `SUBSTRATE_PROXY_PORT`            |          | `8787`               | Port of the coding proxy as the actors reach it (1 to 65535). Set the same value on the proxy.                                                                                                                                                                         |
| `SUBSTRATE_CREDENTIALS_NAMESPACE` |          | `wardby-run-secrets` | Namespace where Wardby creates the per-run Secret. The credential provider must be granted read access to it for the atespace.                                                                                                                                         |
| `SUBSTRATE_KUBE_CONTEXT`          |          | default context      | Kubernetes context used to create and delete the per-run Secrets.                                                                                                                                                                                                      |
| `SUBSTRATE_CA_FILE`               |          | system trust         | CA bundle that verifies the Substrate API's certificate.                                                                                                                                                                                                               |
| `SUBSTRATE_SERVER_NAME`           |          | from the URL         | TLS server name to verify, when it differs from the host in `SUBSTRATE_API_URL`.                                                                                                                                                                                       |
| `SUBSTRATE_WORKER_SELECTOR`       |          | any worker           | Comma-separated `key=value` worker labels; only matching workers count for capacity.                                                                                                                                                                                   |
| `SUBSTRATE_STARTUP_TIMEOUT_SEC`   |          | `300`                | How long the actors may take to reach the coding proxy before the run fails (30 to 7200).                                                                                                                                                                              |
| `SUBSTRATE_COLLECT_GRACE_SEC`     |          | `120`                | After the worker exits without a result, how long the tool side may take to report the workspace before the run fails (10 to 3600).                                                                                                                                    |
| `SUBSTRATE_TEMPLATE_TTL_SEC`      |          | `604800` (7 days)    | Templates no run used for this long are removed (3600 to 7776000). Never less than 27 hours, whatever the value; see [Templates and snapshots](#templates-and-snapshots).                                                                                              |
| `SUBSTRATE_TEMPLATE_READY_SEC`    |          | `900`                | How long a template that is not ready (see [Templates and snapshots](#templates-and-snapshots)) may keep failing to start an actor while the workers have room (counted from the first such refusal) before its runs fail with `substrate_image_unready` (60 to 7200). |
| `SUBSTRATE_TEMPLATE_RETRY_SEC`    |          | `600`                | After a template's golden snapshot fails, the window in which a second failure fails the run with `substrate_image_unready` instead of rebuilding (120 to 86400).                                                                                                      |
| `BLOB_STORE` and its settings     | Yes      |                      | The blob store shared with the proxy. See [Local coding-agent setup](coding-agent-setup.md).                                                                                                                                                                           |

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
| `SUBSTRATE_WORKSPACE_MAX_MB`  |                | `1024`                    | Largest collected workspace a run may upload, per repository (the default one and each writable extra).                                                                                                     |
| `WARDBY_MCP_GATEWAY_URL`      |                | unset                     | For MCP tools: see [Remote MCP servers](security-deployment.md#remote-mcp-servers).                                                                                                                         |
| `BLOB_STORE` and its settings | When routes on |                           | The same blob store as the control plane.                                                                                                                                                                   |

The proxy refuses to start when `SUBSTRATE_ATESPACE` is set and a required
variable is missing, and the error names the variable, never a value. An upload
must arrive within ten minutes of being authenticated.

## What is supported

- Claude Code coding runs, including the package registry (npm and PyPI through
  the proxy), session transcripts (so a run can be resumed), run steps, stop,
  run deadlines and turn limits.
- Codex coding runs, with the same features: the package registry, run steps,
  stop, run deadlines, the budget stop, `codingProfile.gitHistory` runs and
  capacity requeue. See [Codex runs](#codex-runs).
- Plan documents (`codingProfile.planDocument`, `buildFromPlan`): input plan
  files travel in the run input, and the bridge uploads the worker's
  `plan-files.json` before the result, up to the protocol's plan limit (no
  setting). A bridge image from an earlier release does not upload it, so a
  planner run on it stores no plan (`planFilesStatus` `plan_files_missing`):
  use the bridge images from the same release as the proxy.
- `codingProfile.gitHistory` runs (see [Git history](#git-history)).
- Coding runs with remote MCP tools, for Claude Code and Codex (see
  [MCP tools](#mcp-tools)).
- Coding runs with extra repositories, for Claude Code and Codex (see
  [Extra repositories](#extra-repositories)).
- Coding runs with the dependency cache (`codingProfile.dependencyCache`), for
  Claude Code and Codex (see [Dependency cache](#dependency-cache)).
- Custom worker images (`codingProfile.workerImageRef`), for Claude Code and
  Codex (see [Custom images](#custom-images)).
- Coding services (`.wardby/services.yaml`), for Claude Code and Codex (see
  [Coding services](#coding-services)).
- Capacity: a run that cannot be placed because the WorkerPool has no room
  waits in the queue and is retried, like a quota refusal on Kubernetes.

### Codex runs

A Codex run is a single actor: the Codex worker holds the workspace itself, so
there is no tool actor and no workspace hand-off between two actors. The actor
holds only a placeholder for the run capability; Substrate's egress gateway
adds the real one to its requests to the coding proxy (see the
[model request allowlist](coding-worker-isolation.md#model-request-allowlist)).
Its commands run inside the same actor, under the same proxy allowlist and
budget as on the other launchers. When the run ends, the bridge ends any
process the run's commands left behind.

### MCP tools

A coding agent's attached [remote MCP server](mcp-servers.md#coding-agents)
tools work on this launcher, for Claude Code and Codex.

- The coding proxy needs `WARDBY_MCP_GATEWAY_URL` and a network path to the
  native gateway, as for the other launchers (see
  [Remote MCP servers](security-deployment.md#remote-mcp-servers)).
- The actor holds only a placeholder for the run's MCP token. The real token is
  kept in the run's Kubernetes Secret under the `mcpToken` key, and Substrate's
  egress gateway puts it in the `X-Wardby-Mcp-Token` header of the agent
  actor's requests to the proxy's `/mcp` route. The token never enters an
  actor, and a Claude Code tool actor never receives it.
- Codex runs still get only read-only tools. Their commands can use the injected
  token through the proxy's `/mcp` route, but cannot read it.
- MCP runs need this release's coding proxy, Claude worker image, Codex driver
  image and Substrate bridge images. With an older proxy a run's MCP calls are
  refused (401) and the agent has no MCP tools. Upgrade the proxy before you
  send MCP runs to Substrate.
- If the run's MCP token is missing or malformed, the run fails at launch with
  the reason `substrate_mcp_token_invalid` in the control plane log, under the
  run's diagnostic id (see [Troubleshooting](#troubleshooting)).

### Git history

A `gitHistory` run is supported. When the run ends the tool side uploads the
workspace and, from `.git`, only the run's result bundle
(`.git/wardby-result.bundle`), never the rest of the repository's history, so
the history's size does not count toward `SUBSTRATE_WORKSPACE_MAX_MB` or the
extraction limit of 100,000 entries. Before that upload the tool side ends
every process the run's tools started. A bundle that is not a regular file, or
that comes from a `.git` that was swapped while it was read, fails the run
(`substrate_collect_failed`). A bundle over the run's limit
(`CODING_MAX_RESULT_BUNDLE_MB`) fails it with `vcs_result_bundle_too_large`,
and the whole workspace upload, bundle included, must fit
`SUBSTRATE_WORKSPACE_MAX_MB`. A run with no `.git` or no bundle behaves as on
Docker and Kubernetes. See
[Git history in coding runs](../help/git-history.md).

### Extra repositories

A run with extra repositories (see
[Several repositories in one run](coding-agent-setup.md#several-repositories-in-one-run))
works for Claude Code and Codex. Each extra is at `/repos/<name>` in the tool
actor (Claude Code) or the Codex actor, never in Claude's agent actor.

- **Read repositories** are read-only through file permissions, not a mount:
  a file with an execute bit becomes `0555`, other files `0444`, directories
  `0555`, and setuid, setgid and sticky bits are cleared. A command can still
  change its own copy's permissions, but a read repository's content is never
  uploaded or collected.
- **Repositories root.** After seeding, the bridge sets `/repos` to `0755`,
  or else adds the sticky bit, when it is allowed to. On a root-owned mount
  it is not, and the root keeps its mode; the bridge logs
  `substrate_bridge_repos_root_not_hardened` and the run continues. A write
  repository's folder is re-checked before collect either way.
- **Disk.** The default repository and every extra are seeded as tars into one
  budget, the run's disk (`workspaceDiskMb`, else `CODING_DISK_MB`). Over it,
  the run fails at launch with
  [`substrate_seed_too_large`](../help/errors/substrate-seed-too-large.md).
- **Upload cap.** Each writable repository's upload must fit
  `SUBSTRATE_WORKSPACE_MAX_MB` on its own. An extra over it, or whose folder
  was replaced during the run (for example with a symlink, recorded as code
  `repository_changed` in the tool side's `substrate_bridge_collect_failed`
  log line), fails only that repository. If another repository published
  changes, the run ends `partially_published`, as on Docker and Kubernetes. If
  none did, the run fails with that failure. A missing collected workspace
  fails only that extra repository (`failed(workspace)`, counted the same
  way); only the default repository's missing workspace fails the whole run.
- **Git history** works per repository: each writable extra uploads its own
  result bundle (see [Git history](#git-history)).
- **One difference from Docker and Kubernetes.** If collecting the default
  repository fails, the whole run fails on Substrate, extras included; Docker
  and Kubernetes still publish the extras.
- **Warm rounds.** A run with extra repositories never keeps or resumes a warm
  round: every round starts fresh (see
  [When a round starts fresh](#when-a-round-starts-fresh)).
- **Upgrade the coding proxy before the control plane.** These runs need this release's coding
  proxy and Substrate bridge images. An older proxy has no per-repository
  routes, so such a run fails at start with `substrate_collect_failed`.
- **Bridge images.** The bridge images must also be this release or later. An
  older bridge ignores `repositories`: read extras are missing, and write
  extras end `failed(workspace)`.
- **First start.** A run with extra repositories uses its own actor template
  per image and size, so the first such run builds that template's golden
  snapshot and starts more slowly.
- **Cleanup.** If a run's stored repository list cannot be read when the run is
  removed, the control plane logs the warning
  `substrate_run_repositories_unreadable` (the run id only) and the extras'
  stored blobs are left behind. The blob store cannot delete by prefix. Each
  extra's blobs are under `substrate/runs/<token>/repos/<name>/` (`<token>` is
  the run's Substrate token, not its run id). A lifecycle rule on the bucket
  prefix `substrate/runs/` is safe if its age is well past the longest run's
  timeout plus `SUBSTRATE_PARK_TTL_SEC` (at most a day), because that prefix
  also holds live and kept runs' blobs: for example 7 days.

### Dependency cache

The dependency cache (see [Dependency cache](coding-packages.md#dependency-cache))
works on Substrate for Claude Code and Codex as it does on Docker and
Kubernetes. It needs the same switch on the coding proxy,
`WARDBY_DEPENDENCY_CACHE=true`, and uses the proxy's `BLOB_STORE`, which the
Substrate routes already need. Snapshots are stored under `dependency-cache/`
in that store, next to the run files under `substrate/runs/`.

- **Lifecycle rules.** The proxy evicts snapshots by age
  (`WARDBY_DEPENDENCY_CACHE_MAX_AGE_DAYS`). If you add a bucket lifecycle rule
  for Substrate's run files, scope it to `substrate/runs/`; a bucket-wide rule
  would also delete snapshots the proxy still lists.
- **Disk.** Actors have no workspace disk limit of their own, so the cache's
  budget is the run's disk (`workspaceDiskMb`, else `CODING_DISK_MB`), as for
  the seed.
- **Keys.** Snapshots are keyed by the run's image, here the Substrate bridge
  images, so a deployment that moves from Kubernetes starts cold.
- **Warm rounds.** An adopted warm round skips the cache and reports
  `reused_workspace`: its workspace already has the previous round's
  `node_modules`, and the proxy answers cache restore and upload with
  `409 reused_workspace` (sealing still works). The reason is trust: a reused
  workspace was controlled by the previous round's agent, so a snapshot taken
  from it can't be trusted for other runs.
- **Upload digest.** Uploads carry an end-to-end SHA-256 on every launcher; see
  [the trust model](coding-packages.md#the-trust-model).
- **Upgrade together.** The coding proxy, the tool runner images and the worker
  images must all be this release or later. An older tool runner on an adopted
  round still gets `reused_workspace`, from the proxy.

### Coding services

[Coding services](coding-services.md) run on Substrate for Claude Code and
Codex. Each service is a container in the run's workspace actor (the tool
actor, or the Codex actor), started by a wardby script after the run begins;
the agent actor of a Claude Code run resumes only once every service is ready.
The agent's shells receive the same variables as on the other launchers.

- **Start command.** Substrate does not run an image's own entrypoint, so every
  catalog entry a run uses needs a `startCommand`; dispatch refuses a run whose
  entry has none with `service_launcher_unsupported`. The built-in entries
  have one.
- **Images.** A service runs as its image's default user with almost no Linux
  capabilities, so an entrypoint that changes ownership or switches user
  fails. A catalog entry's optional `substrateImage` names another image, by
  registry digest, for Substrate only. The built-in `postgres` entries run
  CloudNativePG's PostgreSQL image, `mysql` 8 runs Percona Server 8.4 (with its
  telemetry off), and `redis` 7 runs the catalog's redis image, started
  directly. Docker and Kubernetes keep the official images. A custom entry with
  `substrateImage` must create `$WARDBY_SERVICE_SETUP_DONE` once its setup is
  done; see
  [Custom entries on Substrate](coding-services.md#custom-entries-on-substrate).
- **Sizing.** The workspace actor is sized with its services on top of the
  run's own share: each service's catalog CPU, and as memory its catalog
  memory plus 64 MiB for each writable path plus 64 MiB. Writes to the data
  path do not count against the actor's memory; files a service writes
  anywhere else do.
  Each new combination of workspace image and services is its own template,
  so its first run waits for a golden snapshot.
- **Start-up bound.** The services' readiness is bounded by their readiness
  settings and `SUBSTRATE_STARTUP_TIMEOUT_SEC`. A run whose service never
  becomes ready fails with
  [`service_unready`](../help/errors/service-unready.md)
  (`coding_service_unready:<name>`).
- **Warm rounds.** A run with services is never kept (see
  [When a round starts fresh](#when-a-round-starts-fresh)).

The details (what a service sees, the network note, the setup-done contract,
the differences between launchers) are in
[On the Substrate job launcher](coding-services.md#on-the-substrate-job-launcher).

### Custom images

An agent's custom image (`codingProfile.workerImageRef`, see
[Bring-your-own coding-worker images](coding-worker-byo-images.md)) runs on
Substrate as on the other launchers. It replaces the same thing:

- **Claude Code:** the tool actor. Claude Code itself always runs on
  `CODING_CLAUDE_WORKER_IMAGE`, never on a custom image.
- **Codex:** the run's one actor.

The image must contain **this release's Substrate bridge**. Add it on top of
your image, with the digest from the `substrateTool` key (Claude Code) or the
`substrateCodex` key (Codex) of `dist/quickstart-images.json` in the npm
package of the same release as your control plane and proxy:

```dockerfile
USER root
COPY --from=ghcr.io/your-org/wardby-substrate-tool@sha256:<digest> /opt/wardby/substrate-bridge/ /opt/wardby/substrate-bridge/
RUN mkdir -p /run/wardby/input /run/wardby/output /run/wardby/tool /workspace \
    && chown -R 10001:10001 /run/wardby /workspace
USER 10001:10001
```

For Codex, copy from `wardby-substrate-codex` instead. For Claude Code you can
instead build `FROM` the release's `wardby-substrate-tool` (or
`wardby-substrate-tool-node-python`) image rather than
`wardby-claude-tool-runner`: it already has the bridge. Two complete examples,
which take both bases as digest-pinned build arguments, are
[`Dockerfile.custom-tool-example`](../src/substrate-bridge/Dockerfile.custom-tool-example)
(Claude Code) and
[`Dockerfile.custom-codex-example`](../src/substrate-bridge/Dockerfile.custom-codex-example)
(Codex).

- **No `ENTRYPOINT` or `CMD` needed.** The launcher sets the command, as the
  Kubernetes and Docker launchers do, and the bridge layer does nothing on
  those launchers. So one image runs on all three.
- **A registry digest only.** `workerImageRef` must be `repo@sha256:<digest>`;
  a tag or a local image ID fails the run with
  [`substrate_image_not_digest`](../help/errors/substrate-image-not-digest.md).
- **The first run is slow.** The first run after you change `workerImageRef`
  waits in the queue while Substrate builds the template's golden snapshot;
  later runs reuse it. Each distinct image and size is its own template (see
  [Templates and snapshots](#templates-and-snapshots)), so keep the number of
  images small.
- **Pull access.** The Substrate workers pull the image themselves; Wardby
  passes no pull credential. For a private registry, configure pull access for
  the Substrate worker nodes.
- **Architecture and disk.** The image's architecture must match the workers',
  and its size counts against the worker nodes' disk.
- **Rebuild on every upgrade**, on the new release's bridge. A bridge from
  another release fails the run with
  [`substrate_bridge_incompatible`](../help/errors/substrate-bridge-incompatible.md).

Before it starts the run, the bridge checks the image and fails the run with
[`substrate_image_incomplete:<item>`](../help/errors/substrate-image-incomplete.md)
if it runs as root, or if the runner, GNU tar, a writable `/workspace` or a
writable `/run/wardby` directory is missing. The Docker and Kubernetes
launchers always run the image as user 10001; Substrate has no such setting,
so the image's last `USER` line decides. End the image with `USER 10001:10001`,
as the examples do. It does not check `/tmp`: an image whose only fault is an
unwritable `/tmp` fails with
[`substrate_startup_timeout`](../help/errors/substrate-startup-timeout.md)
instead.

### Templates and snapshots

Wardby creates one Substrate actor template, and Substrate one golden snapshot,
per role (agent, tool or Codex), image and size. It records every template it
creates in the database (the `SubstrateTemplate` table), with when a launch,
park or adoption last used it.

- **Cleanup.** At start-up, and at most once an hour on a launch, Wardby
  removes up to 50 templates no run used for `SUBSTRATE_TEMPLATE_TTL_SEC`
  (default 7 days): first the record, then the Substrate template. Each removal logs `substrate_template_removed`
  (info). If Substrate refuses the delete, the record is put back, the warning
  `substrate_template_remove_failed` is logged, and the next sweep tries again.
  The removal age is never less than 27 hours, whatever the setting: the
  longest coding run (2 hours) plus the longest `SUBSTRATE_PARK_TTL_SEC`
  (1 day) plus an hour, so a template is never removed under a running or kept
  round. Substrate does not refuse to delete a template that kept actors still
  use; if one goes anyway (removed with Substrate's tooling, say), the next
  round cannot resume them and starts fresh instead (the "no longer available"
  step line under [When a round starts fresh](#when-a-round-starts-fresh)). A
  launch whose template is removed just before it creates its actors creates the
  template again and carries on (see
  [`substrate_template_missing`](../help/errors/substrate-template-missing.md)).
- **Storage.** Golden snapshots cost storage in Substrate, as kept rounds do
  (see [Storage cost](#storage-cost)). `SUBSTRATE_TEMPLATE_TTL_SEC` bounds how
  long an unused one stays.
- **A golden snapshot that fails.** The first failure rebuilds the template.
  Substrate often refuses a run's actor start as unavailable while the golden
  build is failing, before its status says so; Wardby then reads the template's
  status again. A failed build counts as a golden-snapshot failure rather than
  [`substrate_unavailable`](../help/errors/substrate-unavailable.md). A template
  still building (a status with no golden snapshot or no tag yet), on one no actor has started from, is not counted and
  the template is not rebuilt: the run goes back to the queue, and a broken
  build has reported its failure by the time the run is retried, when it is
  counted. A run that counts the first failure, at its start or after a refused start,
  goes back to the queue while the template is rebuilt, and is launched again
  after the backoff.
  A second one within `SUBSTRATE_TEMPLATE_RETRY_SEC` fails the run with
  [`substrate_image_unready`](../help/errors/substrate-image-unready.md)
  instead, and so does a template that never becomes ready within
  `SUBSTRATE_TEMPLATE_READY_SEC` while the workers have room. That time counts
  from the first start Substrate refused while the workers had room, so time a
  new template spent waiting for capacity does not count; a control plane
  restart starts the count again. Wardby judges ready from Substrate's template
  status when Substrate reports it: a template whose golden snapshot is tagged
  is ready (its runs only ever wait for room), and one still building (no
  golden-snapshot status or no tag yet) is not. A template an actor has already started from is always ready: it
  never fails this way, whatever its status says later, and Wardby does not
  read the status again for it. When Substrate reports no golden-snapshot
  status, a template counts as ready once an actor from it has started. A
  golden-snapshot failure always counts as a failure, whatever else the status
  says. A run that finds
  another launch rebuilding its template goes back to the queue and waits, as
  for a capacity refusal; no error is recorded on the run.
- **Log events**, each with the template's name and role and never an image's
  content or Substrate's message: `substrate_template_golden_failed`,
  `substrate_template_unready`, `substrate_template_status_read_failed` (the
  template's status could not be read; when judging ready, Wardby falls back to
  whether an actor has started from it, and after a refused actor start the
  call's own error stands), `substrate_template_record_failed` (the
  failure count could not be written; the template is rebuilt),
  `substrate_template_remove_failed` (all warn) and `substrate_template_removed`
  (info).

## Warm rounds

Warm rounds apply to Claude Code only; Codex rounds always start fresh.

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

A continuation that cannot resume the kept round starts a normal fresh round.
When the launcher reports how a round started, the round gets one run step line
saying so (`get_run` shows `warmStart: true` or `false` on the round):

| Step line                                                                        | Meaning                                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Resumed the previous round's workspace and session                               | The round resumed warm.                                                                                 |
| Started a fresh workspace: the previous round was not kept                       | It did not qualify, or was removed (see below).                                                         |
| Started a fresh workspace: the previous round's sandbox expired                  | `SUBSTRATE_PARK_TTL_SEC` passed.                                                                        |
| Started a fresh workspace: the branch changed since the previous round           | The branch has commits the kept workspace lacks.                                                        |
| Started a fresh workspace: the agent's settings changed since the previous round | A setting the round was launched with changed (see below).                                              |
| Started a fresh workspace: the previous round's sandbox was no longer available  | The actors, or their template, were gone from Substrate, or the actors were not in the suspended state. |
| Started a fresh workspace: there was no room to resume the previous round        | The WorkerPool had no capacity to resume it.                                                            |

A round whose branch preparation merged the target branch into the working
branch (a pull request whose base moved) also starts fresh, because the kept
workspace lacks that merge; it writes no step line. A round with extra
repositories always starts fresh too, and writes no step line (the launcher
records no start reason for it). A run with coding services is never kept;
the next round starts fresh, with empty services (see
[Diagnostics](#diagnostics)).

### What is kept and what is removed

- **Kept:** the workspace, including installed packages, and the Claude
  session (a resumed round skips the dependency cache and reports
  `reused_workspace`).
- **Not kept:** background processes (the tool runner restarts for each round,
  so a dev server or watcher started by one round is gone in the next) and
  credentials (the round's run capability is revoked when it ends; the next
  round gets a new one).
- `stop_run` removes all of that agent's kept rounds.
- `update_agent` removes them when it changes the agent's kind, provider,
  model, system prompt, repository, toolchain, toolchain version, worker image
  (`workerImageRef`) or workspace disk (`workspaceDiskMb`). `delete_agent`
  removes them too.
- A change to the agent's secrets through the MCP tools removes them:
  `attach_secret`, `detach_secret`, `create_secret` with a new value for a
  secret the agent gets (entered in the call or in the browser, or an OAuth
  sign-in confirmed with its code) and `set_secret_broker`. This also covers
  secrets of an MCP server attached to the agent. `delete_secret`,
  `detach_mcp_server`, `delete_mcp_server`, `attach_mcp_server` (a new
  attachment of a server with secrets) and `update_mcp_server` changing
  `secretNames` remove them for the agents concerned. Any other change (an
  OAuth token refresh, say) is caught by the check below.
- A secret that changes while a round runs means that round's transcript is
  not stored (`not_captured`, reason `secrets_changed`): a resumed session
  holds the previous round's raw content, which redaction against the new
  value would miss. This applies to every Claude Code run with session resume,
  warm or not.
- Removed or not, a kept round is resumed only when everything the next round
  launches with matches the kept round: the agent, provider, model, system
  prompt, repository, worker and tool images, CPU, memory and disk limits, and
  the secrets delivered to the run (which secrets, and the version of each, so
  a rotated or refreshed value counts as a change), and the agent's MCP tools
  (which tools of which servers). Otherwise it starts fresh
  with "the agent's settings changed". Wardby compares secrets by identity and
  last change time only, never by value. A kept round's session holds the
  values it saw, so a round after a secret change always starts fresh.
- The MCP changes that remove kept rounds are listed above. Any other change
  to an agent's MCP tools (`attach_mcp_server` with another `allowedTools` or
  for a server without secrets, or `refresh_mcp_server` dropping a tool) is
  caught by the check above, and the next round starts fresh.
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
after the first, so a tail can be matched to its round. The Codex actor sends a
tail of its worker's output the same way. The bridge redacts the worker's
output by exact value (the capability and its placeholder) before it reaches
the actor's own log, and the proxy redacts the tail again before logging it.
The bridges also redact the placeholder for the run's MCP token.

A run with coding services is not offered for keeping at all: its actors are
removed when it finishes, as with warm rounds off, and its next round starts
fresh with empty services.

## Native agents

Sandbox-mode native agents can run on Substrate too, with
`NATIVE_SANDBOX_LAUNCHER=substrate` (experimental, Wardby 0.10.1 and later).
It is a separate setting from `JOB_LAUNCHER`, and reads the same `SUBSTRATE_*`
connection variables, so coding and native runs share one atespace and
credentials namespace (`NATIVE_SANDBOX_SUBSTRATE_WORKER_SELECTOR` can put
native actors on other workers). Each native run is one actor resumed from a
golden snapshot, whose only destination is the native gateway; it needs no
coding proxy, blob store or bridge image. See
[Set up with Agent Substrate](native-sandbox.md#set-up-with-agent-substrate-experimental).

## What is not supported

- Suspend and resume between rounds is off by default: every round starts new
  actors, as on the other launchers. Turn it on with
  [warm rounds](#warm-rounds).
- A coding service whose catalog entry Substrate cannot start (no
  `startCommand`, a `dataPath` that overlaps `/run/wardby-svc`, or a start
  script over its size limit). Dispatch refuses such a run with
  [`service_launcher_unsupported`](../help/errors/service-launcher-unsupported.md);
  a run that reaches the launcher anyway fails with
  [`substrate_feature_unsupported`](../help/errors/substrate-feature-unsupported.md).

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
- **A custom image's runs fail with `substrate_image_unready`.** Substrate could
  not build the template's golden snapshot, or no actor ever started from it.
  Usually the image has no bridge, is built for another architecture, cannot
  be pulled by the workers, or already uses port 8080 (the bridge's readiness
  probe). See
  [`substrate_image_unready`](../help/errors/substrate-image-unready.md).
- **A run with services fails with `service_unready`.** The workspace actor's
  log has `substrate_bridge_service_unready` with the service's name and a
  reason: `start_failed` (no `/bin/sh` in the image, or it never started),
  `exited` (a wrong `startCommand`, or an entrypoint that needs root),
  `probe_failed` (the readiness command kept failing) or `timed_out`. See
  [`service_unready`](../help/errors/service-unready.md).
- **`substrate_bridge_incompatible`.** The image's bridge is from another
  release than the coding proxy. Rebuild the image on this release's bridge,
  and use the bridge images of the same release as the proxy.
- **`substrate_image_incomplete:<item>`.** The bridge found the image lacks
  something it runs: `user` (the image runs as root; end it with
  `USER 10001:10001`), `runner` (the tool runner or Codex worker), `tar` (GNU
  tar), `workspace` (a `/workspace` that the image's user can write) or
  `run_dir` (a `/run/wardby` directory that the image's user can write). See
  [`substrate_image_incomplete`](../help/errors/substrate-image-incomplete.md).

Error articles: [`substrate_unavailable`](../help/errors/substrate-unavailable.md),
[`substrate_capacity`](../help/errors/substrate-capacity.md),
[`substrate_provisioning_failed`](../help/errors/substrate-provisioning-failed.md),
[`substrate_template_missing`](../help/errors/substrate-template-missing.md),
[`substrate_startup_timeout`](../help/errors/substrate-startup-timeout.md),
[`substrate_collect_timeout`](../help/errors/substrate-collect-timeout.md),
[`substrate_collect_failed`](../help/errors/substrate-collect-failed.md),
[`substrate_result_missing`](../help/errors/substrate-result-missing.md),
[`substrate_feature_unsupported`](../help/errors/substrate-feature-unsupported.md),
[`substrate_image_not_digest`](../help/errors/substrate-image-not-digest.md),
[`substrate_seed_too_large`](../help/errors/substrate-seed-too-large.md),
[`substrate_limits_too_small`](../help/errors/substrate-limits-too-small.md),
[`substrate_image_unready`](../help/errors/substrate-image-unready.md),
[`substrate_bridge_incompatible`](../help/errors/substrate-bridge-incompatible.md),
[`substrate_image_incomplete`](../help/errors/substrate-image-incomplete.md).
