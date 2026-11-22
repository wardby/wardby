# Services for coding runs

A coding run can have the services its project's tests need — a PostgreSQL
database, a Redis cache — next to it for the length of the run. The repository
says which services it needs; wardby's service catalog says what each one is;
the agent's owner says which ones the agent may use. Every run gets its own
fresh, empty instance, and the run's sandbox and network policy do not change.

Services work on the Kubernetes job launcher (`JOB_LAUNCHER=kubernetes`,
running Kubernetes 1.29 or later, which its native sidecars need), on the
Docker job launcher (`JOB_LAUNCHER=docker`) and on the experimental Substrate
job launcher (`JOB_LAUNCHER=substrate`), for Codex and Claude Code agents on
all three; see [coding-worker-isolation.md](coding-worker-isolation.md) and
[On the Substrate job launcher](#on-the-substrate-job-launcher). A run
whose agent allows at least one service is refused if its repository declares
one and the deployment can't start services (for example
`JOB_LAUNCHER=local`) — an agent that allows none never reads the declaration
in the first place (see "Allowing services for an agent" below), so its runs
are unaffected by this and start normally on any launcher.

For a local repository (`local:/abs/path`), the declaration is read from the
committed `.wardby/services.yaml` at the base ref, never from the working tree.

## How it works

1. The repository declares its services in `.wardby/services.yaml` on its base
   branch.
2. When a coding run is dispatched, wardby reads that file from the run's base
   branch through the GitHub App (never from the run's own branch), checks each
   entry against the service catalog and the agent's allowed services, and
   either refuses the run or records the resolved services on it.
3. The run starts each service before anything else in the run. On
   Kubernetes each is a native sidecar in the run's pod (an init container
   with `restartPolicy: Always`, which needs Kubernetes 1.29 or later). On
   Docker each is its own container sharing the run's network namespace. On
   Substrate each is a container in the run's workspace actor (see
   [below](#on-the-substrate-job-launcher)). The coding agent does not start
   until every service reports ready.
4. The agent's shells receive each service's variables (such as
   `DATABASE_URL`), and its instructions gain a short note listing the services,
   their variables, and that they start empty. Claude Code runs work the same
   way on both launchers: its tool runner, which actually runs shell commands
   in the repository, reaches every service on `127.0.0.1` with the same
   variables. On Kubernetes the tool runner starts before the service
   sidecars, and the keeper and the agent wait for every service to be ready;
   on Docker the tool runner and the agent are created only after every
   service is ready.
5. When the run ends, its pod (Kubernetes), its containers (Docker) or its
   actors (Substrate) are deleted, and each service and its data go with them.

`get_run` lists a run's services, for example `"services": ["postgres 16"]`.

### On the Substrate job launcher

On the experimental Substrate launcher (see
[substrate-backend.md](substrate-backend.md#coding-services)), each service is
a container in the run's workspace actor: the tool actor for Claude Code, or
the Codex actor. The agent's shells reach it on `127.0.0.1` and receive the
same variables as on the other launchers.

- **Image and command.** The container runs the entry's `substrateImage` when
  it has one, otherwise its `image`. Substrate does not run the image's own
  entrypoint: once the run begins, a wardby start script exports the entry's
  `serviceEnv` and runs its `startCommand`. The image needs `/bin/sh` with
  `sleep` (`timeout` is used when present), so a distroless image cannot run
  there.
- **User.** The container runs as the image's default user, with almost no
  Linux capabilities. An entrypoint that changes file ownership (`chown`) or
  switches user (`gosu`, `su-exec`) fails, which is why the official postgres
  and mysql images cannot start there. On Substrate, use an image whose
  default user is non-root and start the server directly; see
  [Custom entries on Substrate](#custom-entries-on-substrate).
- **Isolation.** A service sees only its own data directory and script
  directory, never the workspace. Its root filesystem is writable, but what it
  writes there (outside `dataPath`) counts against the actor's memory.
- **No restart.** A service that exits during a run is not restarted; the
  run's tests see it gone.
- **Readiness.** Each entry's readiness settings apply within
  `SUBSTRATE_STARTUP_TIMEOUT_SEC`. A service that writes no progress within
  30 seconds of its start (no `/bin/sh` in the image, say) fails at once. For
  an entry with `substrateImage`, readiness passes only when the readiness
  command succeeds **and** the entry's start command has written its setup-done
  file (see below).
- **First runs.** The first run of a new combination of workspace image and
  services also waits in the queue while Substrate pulls the images and builds
  that template's golden snapshot; later runs reuse it.
- **Size.** The workspace actor's CPU and memory include every service's: its
  catalog CPU, and as memory its catalog memory plus 64 MiB for each writable
  path plus 64 MiB. Writes to the data path do not count against the actor's
  memory; files a service writes anywhere else do. `diskMib` is neither
  counted nor enforced, and no service has a CPU or memory limit of its own
  inside the actor.
- **Warm rounds.** A run with services is never kept between
  [warm rounds](substrate-backend.md#warm-rounds); the next round starts fresh,
  with empty services.
- **Network.** On Substrate, a service container shares its workspace actor's
  network access to the coding proxy, so a service image can send the same
  requests repository code in that actor can; use only service images you trust
  as much as the code your agents run.

The built-in entries are set up for Substrate already: `postgres` 15, 16 and 17
run CloudNativePG's PostgreSQL image, `mysql` 8 runs Percona Server 8.4 with
its telemetry off, and `redis` 7 runs the catalog's redis image, started
directly. Docker and Kubernetes keep the official images.

#### Differences between launchers

|                            | Kubernetes                    | Docker                   | Substrate                       |
| -------------------------- | ----------------------------- | ------------------------ | ------------------------------- |
| Service exits during a run | restarted                     | not restarted            | not restarted                   |
| Runs as                    | uid 10001                     | uid 10001                | the image's default user        |
| Image                      | `image`                       | `image`                  | `substrateImage`, else `image`  |
| Disk limit (`diskMib`)     | enforced                      | enforced (memory-backed) | not enforced, not counted       |
| `startCommand`             | ignored                       | ignored                  | required                        |
| Start-up bound             | `KUBERNETES_READY_TIMEOUT_MS` | 120 seconds, fixed       | `SUBSTRATE_STARTUP_TIMEOUT_SEC` |
| Warm rounds                | n/a                           | n/a                      | never kept                      |

## Declaring services in a repository

Commit `.wardby/services.yaml` at the repository root:

```yaml
# Services wardby starts next to coding runs for this repository.
services:
  postgres: "16"
  redis: "7"
```

- `services` is the only key. Each entry is a catalog name and a version.
  Names are lowercase letters, digits and hyphens; versions are short strings
  (quote them, so `"8.0"` stays `8.0`).
- At most five services; the file must be under 8 KiB.
- The file names services only. Images, ports, commands, volumes and
  environment come from the catalog, never from the repository.
- No file means no services.

The file is read from the run's base branch — the agent's `baseRef`, or a
`baseRef` given to `trigger_agent` for that run — never from the run's own
branch. So a builder agent's edit to the declaration in its own pull request
takes effect once that pull request is merged into the base branch, not
before. A coding agent may propose a change in a pull request (see "Letting a
coding agent change the declaration" below).

### Telling your tests where the services are

Tests should read the variables rather than hard-code connection details. A
short note in the repository's `AGENTS.md` helps coding agents and people alike:

```markdown
## Tests

Integration tests need PostgreSQL. They read `DATABASE_URL`
(for example `postgres://test:test@127.0.0.1:5432/test`). In wardby coding
runs it is set for you; locally, start a database and export it yourself.
```

## The service catalog

Anyone with the `agents:read` scope can read the catalog, so an agent's owner
can see which services exist and what variables they provide. Changing it needs
the `services:manage` scope plus a Wardby role that grants it — `service-manager`,
or `admin` (see [roles and privileged operations](security-deployment.md#roles-and-privileged-operations)) —
and every change is written to the control-plane log
(`event: coding.service_catalog.create|update|delete`, with the entry and the
caller's principal id).

| Tool                                 | What it does                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `list_services` (`agents:read`)      | Every entry: name, version, image, `substrateImage` when set, whether it is built in.     |
| `get_service` (`agents:read`)        | One entry in full, including `testEnv`, `startCommand` and `substrateImage`.              |
| `create_service` (`services:manage`) | Adds an entry. The image must be pinned by digest (`repo@sha256:...`).                    |
| `update_service` (`services:manage`) | Changes an entry that is not built in. Runs already dispatched keep what they began with. |
| `delete_service` (`services:manage`) | Removes an entry that is not built in.                                                    |

An entry has:

| Field             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `version` | What a repository declares. Unique together.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `kind`            | `sidecar`: a fresh instance next to each run.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `image`           | The image, pinned by digest.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `port`            | The port it listens on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `serviceEnv`      | Environment for the service container. Per-run throwaway values only; never put a secret here.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `testEnv`         | Variables the agent's shells receive. Upper-case names. Names wardby uses itself are refused: `HOME`, `LANG`, `LC_ALL`, `PATH`, `SHELL`, `TMPDIR`, `USER`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `NODE_OPTIONS`, `NODE_PATH`, `PYTHONPATH`, `PYTHONHOME`, the proxy settings (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`), `SSL_CERT_FILE`, `SSL_CERT_DIR`, and anything starting `WARDBY_`, `CODEX_`, `OPENAI_`, `ANTHROPIC_`, `PIP_`, `NPM_CONFIG_`, `UV_`, `GIT_`, `YARN_`, `PNPM_` or `COREPACK_`. |
| `readiness`       | A command in the image that succeeds once the service accepts connections on `127.0.0.1`, with its period, timeout and failure threshold.                                                                                                                                                                                                                                                                                                                                                                   |
| `resources`       | CPU (millicores), memory (MiB) and disk (MiB). Requests equal limits.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `dataPath`        | The directory the service writes its data to; an empty volume in every run (memory-backed on Docker).                                                                                                                                                                                                                                                                                                                                                                                                       |
| `writablePaths`   | Other directories the image writes to (a socket directory, `/tmp`). The service's root filesystem is read-only.                                                                                                                                                                                                                                                                                                                                                                                             |
| `startCommand`    | The argv that starts the service, its image's ENTRYPOINT + CMD, or for an entry with `substrateImage` a setup script (see [Custom entries on Substrate](#custom-entries-on-substrate)). At most 16 arguments, each one line of at most 4096 bytes. Required on the Substrate launcher; ignored by Docker and Kubernetes.                                                                                                                                                                                    |
| `substrateImage`  | Optional. An image pinned by registry digest (`repo@sha256:<64 hex>`) that the Substrate launcher runs instead of `image`. Requires `startCommand`. Docker and Kubernetes ignore it.                                                                                                                                                                                                                                                                                                                        |

### Built-in services

wardby ships these entries, pinned to the official images by digest. They
change only with a wardby release and cannot be updated or deleted over MCP.

`redis` `7` runs [Valkey](https://valkey.io) 8.1 (BSD-3 licence), the Linux
Foundation's fork of Redis 7.2. It speaks the same protocol and commands, and
its image includes `redis-cli` and `redis-server`, so Redis clients and tests
work unchanged. Redis itself is under RSALv2/SSPLv1 from 7.4 on. To run Redis
instead, add your own catalog entry with `create_service`.

| Service                     | Variables the agent's shells receive                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` `15`, `16`, `17` | `DATABASE_URL=postgres://test:test@127.0.0.1:5432/test`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`                      |
| `redis` `7`                 | `REDIS_URL=redis://127.0.0.1:6379/0`, `REDIS_HOST`, `REDIS_PORT`                                                                       |
| `mysql` `8`                 | `DATABASE_URL=mysql://test:test@127.0.0.1:3306/test`, `MYSQL_HOST`, `MYSQL_TCP_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` |

The credentials are fixed test values, visible to anyone who can read the
catalog: each instance exists only inside one run's pod and is reachable only
from it. Never put a real secret in `serviceEnv`, `testEnv` or `startCommand`.

### Adding your own entry

Use `create_service` for another database version, an extension image, or an
image mirrored into your own registry (for example to avoid Docker Hub pull
limits):

```json
{
  "name": "postgres-postgis",
  "version": "16",
  "image": "registry.example.com/mirror/postgis@sha256:<64 hex digits>",
  "port": 5432,
  "serviceEnv": {
    "POSTGRES_USER": "test",
    "POSTGRES_PASSWORD": "test",
    "POSTGRES_DB": "test",
    "PGDATA": "/var/lib/postgresql/data/pgdata"
  },
  "testEnv": { "DATABASE_URL": "postgres://test:test@127.0.0.1:5432/test" },
  "readiness": {
    "command": ["pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "test", "-d", "test"],
    "periodSeconds": 2,
    "timeoutSeconds": 2,
    "failureThreshold": 30
  },
  "resources": { "cpuMillicores": 500, "memoryMib": 512, "diskMib": 1024 },
  "dataPath": "/var/lib/postgresql/data",
  "writablePaths": ["/var/run/postgresql", "/tmp"]
}
```

On Kubernetes and Docker the image runs as the run pod's non-root user with a
read-only root filesystem and no Linux capabilities, so list every directory it
writes to.
Probe the service over TCP on `127.0.0.1` rather than a Unix socket: database
images commonly start a temporary socket-only server while they initialize.

On the Docker launcher, every directory the image declares as a `VOLUME` must
be its `dataPath` or one of its `writablePaths`. Any other `VOLUME` would be an
unbounded volume on the host's disk, so the run fails its isolation check
instead.

`startCommand` and `substrateImage` cannot be cleared with `update_service`:
to remove one, delete the entry and create it again without it.

### Custom entries on Substrate

For the Substrate launcher an entry needs a `startCommand`; dispatch refuses a
run whose entry has none (see [Errors](#errors)). If the entry's `image` starts
its server directly as a non-root user, `startCommand` is just its ENTRYPOINT
and CMD, for example `["redis-server", "--dir", "/data"]`.

If the image's entrypoint changes ownership or switches user, as the official
database images do, it cannot start on Substrate. Set `substrateImage` to an
image whose default user is non-root and give a `startCommand` that
initialises and runs the server itself. Its contract:

- `startCommand` is required with `substrateImage` (that image's own
  entrypoint is not used); the launcher refuses the entry otherwise.
- The entry's `serviceEnv` is exported before the command runs; read the
  values from the environment, never write them into the command.
- Once setup is done (the database created, the users in place), the command
  must create the file named by `$WARDBY_SERVICE_SETUP_DONE`, then keep the
  server in the foreground. On Substrate such an entry is ready only when its
  readiness command succeeds **and** that file exists; a command that never
  creates it fails when its readiness threshold runs out.
- Each argument is one line (use `;` between commands). The whole start
  script, with the entry's environment, may be at most 16 KiB for one service
  and 64 KiB for a run's services together, measured as JSON-escaped text; a
  run over either is refused at dispatch.

For example, the `postgres-postgis` entry above with a non-root PostGIS image
for Substrate (shortened):

```json
{
  "substrateImage": "registry.example.com/mirror/postgis-nonroot@sha256:<64 hex digits>",
  "startCommand": [
    "/bin/sh",
    "-c",
    "set -u; [ -s \"$PGDATA/PG_VERSION\" ] || initdb -D \"$PGDATA\" -U \"$POSTGRES_USER\" || exit 1; postgres -D \"$PGDATA\" -c listen_addresses=127.0.0.1 & pid=$!; until pg_isready -q -h 127.0.0.1; do sleep 1; done; createdb -h 127.0.0.1 -U \"$POSTGRES_USER\" \"$POSTGRES_DB\" || exit 1; : > \"$WARDBY_SERVICE_SETUP_DONE\"; wait \"$pid\""
  ]
}
```

Give a database enough memory for its idle size on top of its data: MySQL, for
example, needs about 730 MiB idle.

## Allowing services for an agent

The agent's owner lists the catalog names its runs may use (any version the
catalog has):

```json
{ "id": "<agent id>", "codingProfile": { "services": ["postgres", "redis"] } }
```

sent with `update_agent` (or `create_agent`'s `codingProfile`). A name the
catalog doesn't have is refused. An empty list, the default, means no services.

An agent with an empty list never reads `.wardby/services.yaml` at all —
dispatch only looks at the file when the agent allows at least one service.
So an agent that allows no services just starts its runs without services,
whatever a repository declares; every refusal in "Errors" below applies only
to an agent that allows at least one service.

A [bring-your-own worker image](coding-worker-byo-images.md) must be built on
driver v11 or later to run with services; an agent whose `workerImageRef`
predates driver v11 rejects the run input once services are on it. For a
Claude Code agent, build the custom image `FROM` the tool runner image of the
same wardby release.

## Running the agent's commands in your own image (toolchain)

Many test suites need things Wardby's standard images can't provide through the
package proxy: a C extension with no Linux wheel, system libraries, a specific
interpreter, or the settings your team's own dev or CI image already has. A
**toolchain** is a catalog entry for that image. A run that declares one starts
your image, unchanged, next to the run, sharing the run's `/workspace`, and
every command the agent runs is sent there. Reading and editing files,
collection and the pull request work as before.

Toolchains work for **Claude Code agents on the Kubernetes job launcher**. On
the Docker and Substrate launchers, and for Codex agents, dispatch refuses a run
that declares one (see "Errors"). A toolchain is not the same thing as
`codingProfile.toolchain` (`node` or `node-python`), which picks Wardby's own
standard image.

### What your image needs

- **A POSIX shell at `/bin/sh`.** Wardby doesn't install anything in your
  image. Its command agent, a static binary, comes from the run and is your
  image's entrypoint for the run, so your image's own entrypoint does not run
  (see `setupCommand` below).
- **Files readable by any user.** The container runs as the run's user (uid
  10001), not your image's `USER`, with a read-only root filesystem and no
  Linux capabilities. Your interpreter, packages and code must be readable by
  other users (mode 755/644 is typical).
- **Every directory it writes listed in `writablePaths`**, such as `/tmp`.
  `HOME` is a scratch directory Wardby provides at `/home/wardby`, sized by the
  entry's `resources.diskMib`, so pip, Poetry and git configuration work.
  `USER` and `LOGNAME` are set to `wardby`, so code that asks who it is
  running as (Python's `getpass.getuser()`, for example) works even though
  uid 10001 isn't in your image's passwd file. Tools that read the passwd file
  directly, such as `ssh`, still see no name.
- **`git`, if the agent uses git history** (`codingProfile.gitHistory`).
- **No credentials.** The agent can read everything in the image. Pass registry
  credentials to your build as build secrets (`RUN --mount=type=secret,...`),
  never through `ARG` or `ENV`, and check with `docker image inspect` and a
  search for `.npmrc`, `pip.conf`, `.netrc` and `auth.toml` before you
  register the image.
- **The cluster's CPU architecture.** An image built only for amd64 won't start
  on arm64 nodes.

Try it locally under the same rules first:
`docker run --rm --read-only --user 10001:10001 --cap-drop ALL --tmpfs /tmp -e HOME=/tmp <image> sh -c '<one of your tests>'`.

### How commands see your image

- Commands run in your image's environment: its `ENV` (including its `PATH`),
  then the entry's `serviceEnv`, then Wardby's own settings for the run (the
  package proxy's `PIP_*`, `UV_*` and `NPM_CONFIG_*` values, other services'
  `testEnv`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`). Later values win.
- Commands run in a plain shell, not a login shell, so `/etc/profile` doesn't
  reset `PATH`.
- Commands start in `/workspace`. If your image ships its own copy of your
  code (an editable install, for example), check that imports load from
  `/workspace` (`python -c 'import yourpkg; print(yourpkg.__file__)'`).
- Packages already in your image did not pass the package proxy's checks; the
  catalog listing says so. Packages a run installs still go through the proxy.
  Wardby's `npm` and `uv` shims are not available in a toolchain.
- Wardby points `uv.lock` and `poetry.lock` at the package proxy with its own
  Python before the agent starts. Give the agent the `node-python` standard
  image (`codingProfile.toolchain`, `toolchainVersion`) with the same Python
  version as your image, so the project's Python requirement allows it.
- Long test suites may need more than the default per-command time limit; set
  `CODING_BASH_DEFAULT_TIMEOUT_MS` and `CODING_BASH_MAX_TIMEOUT_MS`.

### Register, declare and allow it

Register the image with `create_service` (`services:manage` plus the admin
role), pinned by digest:

```json
{
  "name": "python-dev",
  "version": "3.13",
  "kind": "toolchain",
  "image": "registry.example.com/team/python-dev@sha256:<digest>",
  "serviceEnv": { "DB_HOST": "127.0.0.1" },
  "resources": { "cpuMillicores": 1000, "memoryMib": 1024, "diskMib": 512 },
  "writablePaths": ["/tmp"],
  "setupCommand": ["sh", "-c", "render-config > \"$HOME/app.ini\""]
}
```

A toolchain takes `image`, `serviceEnv`, `testEnv`, `resources`,
`writablePaths`, `setupCommand` and `hostAliases`. It refuses `dataPath`,
`readiness`, `port` and `startCommand`.

`hostAliases` lists host names your code hard-codes for its services, such as
compose service names: `"hostAliases": ["elastic", "mq"]`. In a run every
service listens on `127.0.0.1`, so Wardby resolves each of these names to
`127.0.0.1` with a real hosts entry (your image can't edit `/etc/hosts`
itself, and resolver tricks such as `HOSTALIASES` don't reach every client).
Use lower-case host names, at most 16, not `localhost`. Where you can, make
the host configurable instead, as you would for a database or cache. `setupCommand` runs once per run, after the workspace is
ready and before the agent's first command. It sees your image's `ENV`,
`serviceEnv`, `HOME`, `USER` and `LOGNAME`, but not other services' `testEnv`
or the package proxy's settings, so it can render configuration but not
install packages. Write its output to `HOME` or `/tmp`, not `/workspace`
(anything there is collected into the pull request), and point your app's
config-path variables at it in `serviceEnv`. Its output is never captured.

Declare it in `.wardby/services.yaml` under its own key, beside any services
the tests need, and allow its name on the agent like any service:

```yaml
toolchain:
  python-dev: "3.13"
services:
  postgres: "16"
```

`toolchain:` takes exactly one entry. Wardby's Claude Code agent and tool
runner images from this release carry the command agent; older ones can't run
a toolchain.

If something goes wrong inside the toolchain, the agent sees one of these lines
as a command's output, with exit code 125:

- `wardby-cmd: toolchain_setup_failed`: `setupCommand` exited non-zero or
  didn't finish within the run's timeout. Reproduce it locally with the
  `docker run` line above.
- `wardby-cmd: toolchain_unusable:shell`: the image has no `/bin/sh`.
- `wardby-cmd: toolchain_unusable:agent`: the toolchain can't be reached;
  check that the agent uses this release's images.

## Letting a coding agent change the declaration

Wardby always protects `.wardby/` in coding runs, except
`.wardby/services.yaml`: whatever an agent's own `protectedPaths` say, a coding
run may not change other files under `.wardby/`, and any coding agent may
propose a change to the declaration in its pull request. The change takes
effect only after a person merges it, because runs read the declaration from
the base branch. If a code-review agent reviews the repository's pull
requests, add a line to its instructions asking it to call out any change to
`.wardby/services.yaml`.

Protected-path entries also accept a leading `!` for your own exceptions:
`["docs/**", "!docs/changelog.md"]` protects `docs/` except the changelog.

- An exception is one literal file path: no `*`, `?`, `[ ]` or `{ }`. Entries
  such as `!**` or `!.github/**` are refused, so an exception can never switch
  off a whole protected tree.
- An exception wins over the agent's own patterns, whatever its position.
- Exceptions never apply to the `.wardby/` baseline: nothing under `.wardby/`
  other than `services.yaml` can be unprotected, and `services.yaml` cannot be
  protected again.
- A list must protect at least one path.

## Errors

| Problem                                         | When     | Run                                        | What the requester sees                                                                                                                                                               |
| ----------------------------------------------- | -------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services.yaml` is invalid                      | Dispatch | refused, `service_declaration_invalid`     | "`.wardby/services.yaml` is invalid: <line and reason>."                                                                                                                              |
| The file couldn't be read                       | Dispatch | refused, `service_declaration_unavailable` | "wardby couldn't read `.wardby/services.yaml` from the base branch, so the run was not started. Try again."                                                                           |
| A name and version the catalog doesn't have     | Dispatch | refused, `service_unknown`                 | "This repository asks for `<name> <version>`, which wardby's service catalog doesn't have."                                                                                           |
| A service the agent isn't allowed               | Dispatch | refused, `service_not_allowed`             | "This repository asks for `<name>`, which this agent isn't allowed to use. An admin or the agent's owner can allow it."                                                               |
| Services on a deployment that can't start them  | Dispatch | refused, `service_launcher_unsupported`    | "This repository asks for services, which this wardby deployment can't start: services need the Kubernetes, Docker or Substrate job launcher."                                        |
| A service this launcher can't start             | Dispatch | refused, `service_launcher_unsupported`    | "This repository asks for `<name>`, which this wardby deployment can't start: <reason>." (Substrate; reasons below)                                                                   |
| A toolchain on the Docker or Substrate launcher | Dispatch | refused, `service_launcher_unsupported`    | "This repository asks for the toolchain `<name>`, which this wardby deployment can't start: toolchains are not supported on this launcher yet."                                       |
| A toolchain for a Codex agent                   | Dispatch | refused, `service_launcher_unsupported`    | "This repository asks for the toolchain `<name>`, which this agent can't use: toolchains are not supported for Codex agents yet."                                                     |
| An entry under the wrong key in `services.yaml` | Dispatch | refused, `service_declaration_invalid`     | "`.wardby/services.yaml` is invalid: `<name>` is a toolchain; declare it under `toolchain:`." (or the reverse for a service)                                                          |
| A service never became ready                    | Launch   | failed, category `service_unready`         | "The `<name>` service didn't become ready, so the run couldn't start."                                                                                                                |
| The run's changes touched a protected path      | Collect  | failed, category `protected_path`          | "its changes include `<path>`, which this agent may not edit, so none of its changes were kept. Ask again without changing that file, or have the repository owner make that change." |

For a coding sub-agent of a sandboxed run, these refusals appear when the run starts instead of at dispatch, and the parent's delegation call receives the result.

On the Substrate launcher, `<reason>` is one of:

- "its service catalog entry has no start command": add a `startCommand` with
  `update_service` (built-in entries have one);
- "its service catalog entry's data path overlaps a directory the job launcher
  reserves": the `dataPath` is `/run/wardby-svc`, inside it, or a parent of it
  (such as `/run`); move it;
- "its service catalog entry's environment and commands are too large for the
  job launcher": the start script is over 16 KiB for the service or 64 KiB for
  the run's services together; trim the entry's `serviceEnv` or
  `startCommand`.

A refused run's `error` (from `get_run`) is the code followed by that sentence.
The sentence reaches the requester on the run's status comment and, for a
coding run started by another agent, in that agent's tool result. A
`protected_path` failure is not a service error -- see
[Run changed a protected path](../help/errors/protected-path.md) -- but is
listed here because it uses the same category/sentence mechanism.

On Kubernetes, a service is "not ready" when its readiness command keeps
failing past its failure threshold (the sidecar restarts), its image can't be
pulled or started, or it has still not started when the launcher's pod-start
bound (`KUBERNETES_READY_TIMEOUT_MS`, default 120000) is reached. So an entry's
readiness is bounded by that timeout: a `failureThreshold` × `periodSeconds`
longer than it never takes effect. Pulling a service image adds to pod start
time; raise that bound if first pulls on new nodes are slow.

On Docker, the launcher starts the services one at a time and runs each
readiness command with `docker exec` every `periodSeconds`, each attempt
bounded by `timeoutSeconds`. A service is "not ready" after `failureThreshold`
consecutive failures, when its container can't be created or started or
exits, when its image can't be pulled within 5 minutes, or when the run's
services are still not all ready after 120 seconds. Unlike Kubernetes's
pod-start bound, that 120-second limit is fixed: it has no environment
variable, so raising it means switching to the Kubernetes launcher. It covers
creating, starting and probing every service of the run together, not image
pulls, and start-up never runs past the run's own timeout either. So an
entry's readiness settings apply within that limit: a `failureThreshold` ×
(`periodSeconds` + `timeoutSeconds`) longer than it never takes effect. The
launcher uses a local copy of the digest-pinned image when the Docker host
has one and otherwise pulls it without registry credentials. For a private
registry, or to avoid public pull limits, pull the image on the Docker host
beforehand (`docker pull <image>@sha256:<digest>`).

On Substrate, a service is "not ready" when its readiness command keeps
failing past its failure threshold, when it exits, when it writes no progress
within 30 seconds of its start, when its image can't be pulled, or when the
run's services are still not all ready within the entry's readiness settings,
bounded by `SUBSTRATE_STARTUP_TIMEOUT_SEC` (default 300). The Substrate
workers pull images themselves, without credentials from wardby; configure
pull access on the worker nodes for a private registry.

## Cost and capacity

Each service reserves its catalog resources for the whole run, on top of the
worker's: CPU and memory at their requests (equal to limits), and ephemeral
storage for its data volume plus 64 MiB for each writable path. They count
toward the namespace's ResourceQuota and, on GKE Autopilot, toward what you are
billed for the run's pod and its 10 GiB pod ephemeral-storage ceiling. A run
whose workspace and services together exceed that ceiling fails before its pod
is created.

On the Docker launcher everything a service stores is in memory: its data
path and each writable path are tmpfs mounts, so its memory limit is its
catalog memory plus its disk (its data volume and 64 MiB for each writable
path) plus 64 MiB of shared memory, with its catalog CPU and at most 512
processes. Size the Docker host's RAM for `CODING_MAX_CONCURRENT` runs with
their services. A service that exits during a run is not restarted on Docker;
the run's tests see it gone.

Unlike a managed Kubernetes tier such as GKE Autopilot, which checks a
resource ceiling per pod, the Docker launcher does not cap the combined memory
of a single run's services. Size a Docker host's RAM for the worker plus the
worst case a repository could declare in one run: up to five services, each
at its catalog entry's memory plus disk plus 64 MiB. A custom catalog entry's
`resources` (`create_service`/`update_service`) is what sets those numbers, so
review them before allowing a repository to declare more or larger services.

On Substrate a run's services are sized into its workspace actor on top of the
run's own share: each service's catalog memory, plus 64 MiB for each writable
path, plus 64 MiB. The data disk is not counted, because writes to the data
path do not count against the actor's memory; writes anywhere else (such as
`/tmp`) do. Size the WorkerPool for the worst case a repository could declare.
The built-in `mysql` 8 entry, for example, adds 1216 MiB.

## Upgrading an existing deployment

`services:manage` is a new scope. If your deployment delegates to an
identity provider, define `services:manage` in the provider before you deploy
this release: clients that request every advertised scope otherwise fail with
`invalid_scope`. Map the `service-manager` role (or use `admin`) for the people
who maintain the catalog; see
[getting-started-identity-provider.md](getting-started-identity-provider.md#wardby-roles).

Existing agents are allowed no services until their owners add
`codingProfile.services`, and every existing agent gets the `.wardby/`
protected-path baseline without any change to its settings.

### Services on the Substrate launcher

This release adds the catalog fields `startCommand` and `substrateImage`
(migrations `20261124000000_substrate_services`,
`20261126000000_coding_service_substrate_image` and
`20261127000000_builtin_service_setup_done`, applied with
`prisma migrate deploy`). The migrations set both on the built-in entries;
Docker and Kubernetes runs are unchanged. A custom entry needs a
`startCommand` (set it with `update_service`), and a `substrateImage` too if
its image's entrypoint changes ownership or switches user, before Substrate
runs can use it; until then dispatch refuses them with
`service_launcher_unsupported`.

### From 0.7.0: `YARN_*`, `PNPM_*` and `COREPACK_*` are reserved

From Wardby 0.7.0 a service's `testEnv` can't set a variable starting
`YARN_`, `PNPM_` or `COREPACK_`: the worker uses them to point yarn, pnpm and
corepack at the package registry (see
[pnpm and yarn](coding-packages.md#pnpm-and-yarn)). A custom catalog entry
that sets one fails to load after the upgrade, and so does a run that
declares it. Before you upgrade, list the catalog (`list_services`) and
remove those variables from any entry's `testEnv` with `update_service`.
After the upgrade such an entry can no longer be read or updated: delete it
with `delete_service` and create it again without those variables. The
built-in services set none.
