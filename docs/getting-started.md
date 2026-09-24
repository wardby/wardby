# Getting started

This guide gets a local Wardby control plane running without installing
PostgreSQL or cloning the Wardby repository. Wardby keeps its database and
configuration isolated from the application in which you run it.

For a shared deployment with isolated Kubernetes coding workers, use the
[GKE getting-started guide](getting-started-gke.md).

## Requirements

- Node.js 24 or newer.
- Docker with Docker Compose v2.
- An OpenAI or Anthropic API key.
- Optional: Codex or Claude Code, if you want `quickstart` to register Wardby
  as an MCP server.

## Run quickstart

From the repository where you want to use Wardby:

```sh
npx --yes @wardby/cli@latest quickstart
```

The guided command:

1. checks Node, Docker, Docker Compose, and the Docker daemon;
2. creates a private `.wardby/.env` and project state;
3. adds `.wardby/` to the repository's `.gitignore`;
4. starts PostgreSQL 16 in Docker on the first available local port beginning
   at `55432`;
5. applies Wardby's packaged Prisma migrations;
6. creates the `hello-wardby` sample agent with a `$1` maximum run budget;
7. asks before making the billed model request; and
8. optionally registers the local stdio MCP server with Codex, Claude Code, or
   both.

Provider credentials and `SECRET_APP_KEY` are written with owner-only file
permissions. They are not printed, passed as command-line arguments, or added
to the application's own `.env` files.

## Unattended setup

Automation must explicitly accept the billed demo with `--yes`:

```sh
OPENAI_API_KEY="..." npx --yes @wardby/cli@latest quickstart \
  --provider openai \
  --model gpt-5.6-luna \
  --budget 1 \
  --client codex \
  --non-interactive \
  --yes
```

Use `--skip-demo` to prepare the database without making a provider request.
This is useful for CI and package verification:

```sh
npx --yes @wardby/cli@latest quickstart \
  --provider openai \
  --non-interactive \
  --skip-demo
```

## Operate the local installation

Run these from the same project directory. Set `WARDBY_PROJECT_DIR` to that
directory when invoking Wardby from somewhere else.

```sh
npx --yes @wardby/cli@latest doctor
npx --yes @wardby/cli@latest status
npx --yes @wardby/cli@latest logs --tail 100
npx --yes @wardby/cli@latest down
```

`down` stops PostgreSQL but preserves its named volume. Removing the database
is intentionally explicit:

```sh
npx --yes @wardby/cli@latest down --volumes
```

`quickstart` is safe to rerun. It reuses the project identity, port, secrets,
and database volume, reapplies idempotent migrations, and updates the sample
agent instead of creating duplicates.

## MCP configuration

Passing `--client codex`, `--client claude`, or `--client both` lets quickstart
register Wardby after showing the choice interactively. The generated stdio
entry launches the same package version and sets `WARDBY_PROJECT_DIR`, so the
MCP process finds this project's private Wardby configuration regardless of the
client's current working directory.

After connecting, try:

> List my Wardby agents, show the latest run and its actual cost, then create a
> new agent with a maximum budget of $0.50. Do not run it yet.

## Coding agents

The first-run demo proves native model routing, budget admission, persistence,
and accounting. It deliberately does not install a GitHub App or build worker
images.

Coding agents require the stronger boundary described in
[Coding-agent setup](coding-agent-setup.md): a dedicated GitHub App, immutable
worker image, trusted coding proxy, and either Docker or Kubernetes as the job
launcher. Run `wardby coding preflight` before enabling a production repository.

## Next steps

- [Runtime architecture](architecture-runtime.md)
- [Coding-agent setup](coding-agent-setup.md)
- [Bring your own identity provider](getting-started-identity-provider.md)
- [Observability](observability.md)
- [GKE deployment](getting-started-gke.md)
- [Security deployment guide](security-deployment.md)
