# Developing Wardby

This page is for people changing Wardby itself. If you want to use Wardby, see
the [README](README.md).

## Set up from source

Requirements: Node.js 24 or newer and Docker.

```sh
git clone https://github.com/wardby/wardby.git
cd wardby
npm ci
npm run build
npm test
```

The local development database runs in Docker:

```sh
npm run db:up      # PostgreSQL on :55432
npm run prisma:generate
npm run prisma:migrate
npm run db:down
```

## Rules for contributing

- [CONTRIBUTING.md](CONTRIBUTING.md): the development database, required
  checks, sign-off and contribution expectations.
- [CLAUDE.md](CLAUDE.md): the strict rules for commits, database migrations,
  LLM pricing tables, deployment modules and public docs. It is the single home
  for those rules.
- [CLEANROOM.md](CLEANROOM.md): the clean-room rules that bind all work here.
- [SECURITY.md](SECURITY.md): report a vulnerability privately.

## Repository map

```text
src/core/       Agents, runner, scheduler, triggers, budgets, and sandbox
src/mcp/        MCP transports, authentication, and management tools
src/providers/  Swappable model, job, VCS, email, auth, secret, and storage seams
src/coding-worker/ and src/claude-coding-worker/
                Isolated Codex and Claude Code execution
deploy/         Local, production-reference, observability, and cloud deployment
prisma/         Schema and reviewed migrations
docs/           Architecture, security, setup, and operator guidance
help/           Short articles served by the search_help MCP tool
```

## Useful scripts

| Script                                                                     | Purpose                                              |
| -------------------------------------------------------------------------- | ---------------------------------------------------- |
| `npm run typecheck`, `npm run lint`, `npm run format:check`                | Static checks                                        |
| `npm test`                                                                 | Unit tests (database tests skip without PostgreSQL)  |
| `npm run build`                                                            | Build the CLI, the help index and the viewer schemas |
| `npm run observability:up`, `:smoke`, `:down`                              | Local Prometheus and Grafana proof, no paid requests |
| `npm run test:docker-isolation`, `test:docker-job`, `test:docker-services` | Docker-backed worker isolation tests                 |

See `package.json` for the full list.

## Architecture and references

- [Runtime architecture](docs/architecture-runtime.md)
- [Coding-worker isolation model](docs/coding-worker-isolation.md)
- [Native sandbox](docs/native-sandbox.md)
- [Security deployment guide](docs/security-deployment.md)
- [Release verification](docs/release-verification.md)
- [Observability guide](docs/observability.md)
