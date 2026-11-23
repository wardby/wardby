---
id: coding-services
title: Give coding runs the services their tests need
summary: Let coding runs on the Kubernetes, Docker or Substrate launcher start fresh PostgreSQL, Redis or MySQL instances declared in the repository's .wardby/services.yaml; startCommand and substrateImage for Substrate; a rootless Docker daemon (docker kind) on Kubernetes with gVisor.
audience: operator
tags: [coding-agents, services, postgres, redis, valkey, mysql, substrate, startCommand, substrateImage, docker]
appliesTo: >=0.2.1
---

# Give coding runs the services their tests need

A coding run can have a PostgreSQL, Redis or MySQL instance next to it for the
length of the run. Three parties agree before a service starts:

- **The repository** declares it in `.wardby/services.yaml` on its base branch,
  for example `services: { postgres: "16" }`. Wardby reads the file from the
  run's base branch (the agent's `baseRef`, or a `baseRef` given to
  `trigger_agent` for that run), never from the run's own branch, so a change
  to the declaration takes effect only once it is merged into that base.
- **The service catalog** says what each name and version is: a digest-pinned
  image, its readiness check, resources, and the variables the agent's shells
  receive (`testEnv`, such as `DATABASE_URL`). `list_services` and
  `get_service` need `agents:read`. `create_service`, `update_service` and
  `delete_service` need `services:manage` and the `admin` or
  `service-manager` role. Built-in entries (`postgres` 15, 16 and 17, `redis`
  7, `mysql` 8) cannot be changed over MCP. `redis` 7 runs Valkey 8.1
  (BSD-3), a drop-in fork of Redis 7.2; add your own entry to run Redis.
- **The agent's owner** lists the catalog names its runs may use in
  `codingProfile.services`. An empty list, the default, allows none.

An agent with an empty list never reads the repository's declaration at all —
wardby only looks at `.wardby/services.yaml` for an agent that allows at least
one service. Such an agent's runs simply start without services, whatever a
repository declares, and none of the errors below can apply to them.

Services need the Kubernetes job launcher with Kubernetes 1.29 or later (each
service runs as a native sidecar in the run's pod), the Docker job launcher
(each service runs as its own container sharing the run's network namespace)
or the experimental Substrate job launcher (see
[Substrate launcher](#substrate-launcher)); all three start them for Codex and
Claude Code agents. Each run gets its own empty
instance, reachable on `127.0.0.1`; the run's sandbox and network policy do
not change, and the instance is deleted with the run. Each service's CPU,
memory and disk count toward the run: on Kubernetes toward its pod, namespace
quota and what a managed cluster bills; on Docker toward the host's memory,
because its data is kept in memory.

A bring-your-own worker image
([`docs/coding-worker-byo-images.md`](../docs/coding-worker-byo-images.md))
needs driver v11 or later to run with services.

Catalog values are visible to anyone with `agents:read`. Use throwaway test
credentials only; never put a real secret in `serviceEnv`, `testEnv` or `startCommand`.

Every run protects `.wardby/**` except `.wardby/services.yaml`, so a coding
agent may propose a declaration change in its pull request but cannot change
other `.wardby/` files. An agent's own `protectedPaths` exceptions (entries
starting with `!`) must be literal file paths and cannot unprotect `.wardby/`.

When upgrading a deployment that delegates to an identity provider, define the
`services:manage` scope in the provider first; see
[Configure identity and privileged access](identity-and-access.md).

For a repository on the wardby host (`local:/absolute/path`), the declaration is
read from the committed file at the run's base ref, never the working tree; see
[Use local git repositories](local-repositories.md).

To run the agent's commands in your team's own dev image instead of next to it,
declare a toolchain; see
[Run a coding agent's commands in your own dev image](coding-toolchain.md).

If a run is refused or fails over its services, read the page for its code:

- [`service_declaration_invalid`](errors/service-declaration-invalid.md)
- [`service_declaration_unavailable`](errors/service-declaration-unavailable.md)
- [`service_unknown`](errors/service-unknown.md)
- [`service_not_allowed`](errors/service-not-allowed.md)
- [`service_launcher_unsupported`](errors/service-launcher-unsupported.md)
- [`service_kind_unsupported`](errors/service-kind-unsupported.md)
- [`service_unready`](errors/service-unready.md)

Read [`docs/coding-services.md`](../docs/coding-services.md) for the file
format, catalog fields, built-in variables, custom entries, and capacity.

## Substrate launcher

From release 0.10.1 the experimental `JOB_LAUNCHER=substrate` starts services
too, for Claude Code and Codex. Each service is a container in the run's
workspace actor (the tool actor, or the Codex actor), reachable on
`127.0.0.1`, and the agent's shells receive the same variables as on the other
launchers.

- **`startCommand`.** Substrate does not run an image's own entrypoint, so
  every catalog entry a run uses needs a `startCommand`: the argv that starts
  the service (at most 16 arguments, each one line of at most 4096 bytes).
  Docker and Kubernetes ignore it. Built-in entries have one; give a custom
  entry one with `update_service`, or dispatch refuses the run with
  [`service_launcher_unsupported`](errors/service-launcher-unsupported.md).
- **`substrateImage`.** A service runs as its image's default user with almost
  no Linux capabilities, so an entrypoint that runs `chown` or
  switches user (`gosu`) fails. An entry's optional `substrateImage`, pinned by
  registry digest (`repo@sha256:<64 hex>`), is the image Substrate runs
  instead of `image`; Docker and Kubernetes ignore it. Use an image whose
  default user is non-root and start the server directly. It requires
  `startCommand`. `get_service` shows both fields; `list_services` shows
  `substrateImage` only when it is set. Neither can be cleared with
  `update_service`: delete the entry and create it again.
- **Setup done.** An entry with `substrateImage` must create the file named by
  `$WARDBY_SERVICE_SETUP_DONE` once its setup is done (database and users
  created), then keep the server running. On Substrate it is ready only when
  its readiness command succeeds and that file exists. For example, a
  PostgreSQL entry's script ends with:

  ```sh
  createdb -h 127.0.0.1 -U "$POSTGRES_USER" "$POSTGRES_DB" || exit 1
  : > "$WARDBY_SERVICE_SETUP_DONE"; wait "$pid"
  ```

  (In the entry each argument is one line: join the commands with `;`.)

- **Size limits.** A service's start script, with its environment, may be at
  most 16 KiB, and a run's services 64 KiB together (JSON-escaped). A larger
  one is refused at dispatch.
- **Built-ins.** `postgres` 15, 16 and 17 run CloudNativePG's PostgreSQL image
  on Substrate, `mysql` 8 runs Percona Server 8.4 with its telemetry off, and
  `redis` 7 starts the catalog's redis image directly. Docker and Kubernetes
  keep the official images.
- **Sizing.** The workspace actor is sized with its services: their CPU, and
  as memory each one's memory plus 64 MiB per writable path plus 64 MiB.
  Writes to the data path don't count against memory; writes anywhere else
  do. `diskMib` is not enforced as a disk limit. MySQL needs about
  730 MiB idle.
- **No restart, no warm rounds.** A service that exits is not restarted, and a
  run with services is never kept between warm rounds: its actors are removed
  when it finishes, and the next round starts with empty services.
- **Network.** A service container shares its workspace actor's access to the
  coding proxy; use only service images you trust as much as the code your
  agents run.

See [On the Substrate job launcher](../docs/coding-services.md#on-the-substrate-job-launcher)
and the `job-launcher-substrate` help article.

## Docker in coding runs (`docker` kind)

A catalog entry of kind `docker` gives each run a rootless Docker daemon, so
the agent can `docker build`, `docker run`, run `docker compose` and scan the
images it builds. Its shells receive
`DOCKER_HOST=unix:///wardby/docker/docker.sock`.

- **Where.** Only the Kubernetes job launcher with
  `KUBERNETES_RUNTIME_CLASS=gvisor`. Everywhere else (the Docker and Substrate
  launchers, Kubernetes without gVisor) dispatch refuses the run with
  [`service_kind_unsupported`](errors/service-kind-unsupported.md). At most
  one `docker` service per run.
- **Image.** `wardby-docker-service`, pinned by digest: build it from
  `src/docker-service/Dockerfile` (Docker's rootless image plus a user and
  subordinate id range for uid 10001) and push it to a registry your cluster
  pulls from.

- **Entry.** `create_service` with `kind: "docker"` takes only `name`,
  `version`, `image` and `resources` (`diskMib` sizes images and build
  cache); wardby sets the daemon's arguments, environment, security context,
  volumes and readiness, and refuses `port`, `serviceEnv`, `testEnv`,
  `readiness`, `startCommand`, `substrateImage`, `dataPath` and
  `writablePaths`. No `docker` entry is built in.
- **CLI.** The Claude Code tool runner image and the Codex worker driver
  image ship the `docker` CLI and `docker compose` plugin. A bring-your-own
  image built on an older base needs them installed.
- **Pulls.** None yet: the daemon points its registry mirror at the coding
  proxy, which does not serve container images in this release, and the run's
  network policy blocks every registry. `docker build` and `docker run` of an
  image the run has not built itself fail to pull. No pushes.
- **Networking.** Host networking only: `docker build --network=host`,
  `docker run --network=host`, `network_mode: host` in compose. The default
  network has no DNS. Containers it starts cannot reach the run's other
  services on `127.0.0.1`.
- **Security.** The daemon is rootless (root inside its containers is the
  run's unprivileged user outside) and gets no secret value. Its socket gives
  the agent's shell control of that daemon inside the run's gVisor sandbox;
  gVisor stays the boundary to the node.

See [Docker in coding runs](../docs/coding-services.md#docker-in-coding-runs-docker-kind)
and [The docker service container](../docs/coding-worker-isolation.md#the-docker-service-container).
