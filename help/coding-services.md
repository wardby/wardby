---
id: coding-services
title: Give coding runs the services their tests need
summary: Let coding runs on the Kubernetes or Docker launcher start fresh PostgreSQL, Redis or MySQL instances declared in the repository's .wardby/services.yaml.
audience: operator
tags: [coding-agents, services, postgres, redis, mysql, kubernetes, docker]
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
  7, `mysql` 8) cannot be changed over MCP.
- **The agent's owner** lists the catalog names its runs may use in
  `codingProfile.services`. An empty list, the default, allows none.

An agent with an empty list never reads the repository's declaration at all —
wardby only looks at `.wardby/services.yaml` for an agent that allows at least
one service. Such an agent's runs simply start without services, whatever a
repository declares, and none of the errors below can apply to them.

Services need the Kubernetes job launcher with Kubernetes 1.29 or later (each
service runs as a native sidecar in the run's pod) or the Docker job launcher
(each service runs as its own container sharing the run's network namespace);
both start them for Codex and Claude Code agents. Each run gets its own empty
instance, reachable on `127.0.0.1`; the run's sandbox and network policy do
not change, and the instance is deleted with the run. Each service's CPU,
memory and disk count toward the run: on Kubernetes toward its pod, namespace
quota and what a managed cluster bills; on Docker toward the host's memory,
because its data is kept in memory.

A bring-your-own worker image
([`docs/coding-worker-byo-images.md`](../docs/coding-worker-byo-images.md))
needs driver v11 or later to run with services.

Catalog values are visible to anyone with `agents:read`. Use throwaway test
credentials only; never put a real secret in `serviceEnv` or `testEnv`.

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

If a run is refused or fails over its services, read the page for its code:

- [`service_declaration_invalid`](errors/service-declaration-invalid.md)
- [`service_declaration_unavailable`](errors/service-declaration-unavailable.md)
- [`service_unknown`](errors/service-unknown.md)
- [`service_not_allowed`](errors/service-not-allowed.md)
- [`service_launcher_unsupported`](errors/service-launcher-unsupported.md)
- [`service_unready`](errors/service-unready.md)

Read [`docs/coding-services.md`](../docs/coding-services.md) for the file
format, catalog fields, built-in variables, custom entries, and capacity.

## Substrate launcher

The experimental `JOB_LAUNCHER=substrate` does not support this feature yet; a
run that needs it fails with
`substrate_feature_unsupported`. Use the
Docker or Kubernetes launcher. See
the `job-launcher-substrate` help article.
