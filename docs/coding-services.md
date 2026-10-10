# Services for coding runs

A coding run can have the services its project's tests need — a PostgreSQL
database, a Redis cache — next to it for the length of the run. The repository
says which services it needs; wardby's service catalog says what each one is;
the agent's owner says which ones the agent may use. Every run gets its own
fresh, empty instance, and the run's sandbox and network policy do not change.

Services work on the Kubernetes job launcher (`JOB_LAUNCHER=kubernetes`,
running Kubernetes 1.29 or later, which its native sidecars need) and on the
Docker job launcher (`JOB_LAUNCHER=docker`), for Codex and Claude Code agents
on both; see [coding-worker-isolation.md](coding-worker-isolation.md). A run
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
   Docker each is its own container sharing the run's network namespace. The
   coding agent does not start until every service reports ready.
4. The agent's shells receive each service's variables (such as
   `DATABASE_URL`), and its instructions gain a short note listing the services,
   their variables, and that they start empty. Claude Code runs work the same
   way on both launchers: its tool runner, which actually runs shell commands
   in the repository, reaches every service on `127.0.0.1` with the same
   variables. On Kubernetes the tool runner starts before the service
   sidecars, and the keeper and the agent wait for every service to be ready;
   on Docker the tool runner and the agent are created only after every
   service is ready.
5. When the run ends, its pod (Kubernetes) or its containers (Docker) are
   deleted, and each service and its data go with them.

`get_run` lists a run's services, for example `"services": ["postgres 16"]`.

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
| `list_services` (`agents:read`)      | Every entry: name, version, image, whether it is built in.                                |
| `get_service` (`agents:read`)        | One entry in full, including `testEnv`, the variables a run's shells receive.             |
| `create_service` (`services:manage`) | Adds an entry. The image must be pinned by digest (`repo@sha256:...`).                    |
| `update_service` (`services:manage`) | Changes an entry that is not built in. Runs already dispatched keep what they began with. |
| `delete_service` (`services:manage`) | Removes an entry that is not built in.                                                    |

An entry has:

| Field             | Meaning                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `version` | What a repository declares. Unique together.                                                                                                             |
| `kind`            | `sidecar`: a fresh instance next to each run.                                                                                                            |
| `image`           | The image, pinned by digest.                                                                                                                             |
| `port`            | The port it listens on.                                                                                                                                  |
| `serviceEnv`      | Environment for the service container. Per-run throwaway values only; never put a secret here.                                                           |
| `testEnv`         | Variables the agent's shells receive. Upper-case names; names wardby uses itself (`PATH`, `HOME`, `PIP_*`, `WARDBY_*`, proxy settings, ...) are refused. |
| `readiness`       | A command in the image that succeeds once the service accepts connections on `127.0.0.1`, with its period, timeout and failure threshold.                |
| `resources`       | CPU (millicores), memory (MiB) and disk (MiB). Requests equal limits.                                                                                    |
| `dataPath`        | The directory the service writes its data to; an empty volume in every run (memory-backed on Docker).                                                    |
| `writablePaths`   | Other directories the image writes to (a socket directory, `/tmp`). The service's root filesystem is read-only.                                          |

### Built-in services

wardby ships these entries, pinned to the official images by digest. They
change only with a wardby release and cannot be updated or deleted over MCP.

| Service                     | Variables the agent's shells receive                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` `15`, `16`, `17` | `DATABASE_URL=postgres://test:test@127.0.0.1:5432/test`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`                      |
| `redis` `7`                 | `REDIS_URL=redis://127.0.0.1:6379/0`, `REDIS_HOST`, `REDIS_PORT`                                                                       |
| `mysql` `8`                 | `DATABASE_URL=mysql://test:test@127.0.0.1:3306/test`, `MYSQL_HOST`, `MYSQL_TCP_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` |

The credentials are fixed test values, visible to anyone who can read the
catalog: each instance exists only inside one run's pod and is reachable only
from it. Never put a real secret in `serviceEnv` or `testEnv`.

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

The image runs as the run pod's non-root user with a read-only root
filesystem and no Linux capabilities, so list every directory it writes to.
Probe the service over TCP on `127.0.0.1` rather than a Unix socket: database
images commonly start a temporary socket-only server while they initialize.

On the Docker launcher, every directory the image declares as a `VOLUME` must
be its `dataPath` or one of its `writablePaths`. Any other `VOLUME` would be an
unbounded volume on the host's disk, so the run fails its isolation check
instead.

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

| Problem                                        | When     | Run                                        | What the requester sees                                                                                                                                                               |
| ---------------------------------------------- | -------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services.yaml` is invalid                     | Dispatch | refused, `service_declaration_invalid`     | "`.wardby/services.yaml` is invalid: <line and reason>."                                                                                                                              |
| The file couldn't be read                      | Dispatch | refused, `service_declaration_unavailable` | "wardby couldn't read `.wardby/services.yaml` from the base branch, so the run was not started. Try again."                                                                           |
| A name and version the catalog doesn't have    | Dispatch | refused, `service_unknown`                 | "This repository asks for `<name> <version>`, which wardby's service catalog doesn't have."                                                                                           |
| A service the agent isn't allowed              | Dispatch | refused, `service_not_allowed`             | "This repository asks for `<name>`, which this agent isn't allowed to use. An admin or the agent's owner can allow it."                                                               |
| Services on a deployment that can't start them | Dispatch | refused, `service_launcher_unsupported`    | "This repository asks for services, which this wardby deployment can't start: services need the Kubernetes or Docker job launcher."                                                   |
| A service never became ready                   | Launch   | failed, category `service_unready`         | "The `<name>` service didn't become ready, so the run couldn't start."                                                                                                                |
| The run's changes touched a protected path     | Collect  | failed, category `protected_path`          | "its changes include `<path>`, which this agent may not edit, so none of its changes were kept. Ask again without changing that file, or have the repository owner make that change." |

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
