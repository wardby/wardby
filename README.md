# reevo-run

Schedule and run **budget-guarded LLM agents** — autonomous agents that run on a
schedule or in response to events, with hard spend limits that stop _before_
cost, and a sandboxed tool executor.

> Reevo runs your agents on a schedule, within a budget.

## Who it's for

People who want to run a handful of scheduled Claude, Codex, or other LLM
agents on their own box or VPS, with a hard spend cap they can trust, and
without handing tool execution to an unsandboxed process.

## Status

Working. The core engine, scheduler, budget groups, QuickJS tool sandbox,
secrets, webhooks, MCP server (stdio and OAuth 2.1 HTTP), and containerized
coding workers are implemented and tested.

## Architecture at a glance

reevo-run is a **cloud-agnostic core** with swappable **provider seams**. The
core never imports a cloud SDK; each external dependency sits behind an
interface with a default (portable) adapter and optional native adapters.

```
src/
  core/            cloud-agnostic domain: agents, tools, runner, scheduler,
                   triggers, sandbox, secrets, webhooks
  config/          provider selection from environment
  providers/
    jobs/          JobLauncher     — dispatch long-running work
    email/         EmailProvider   — outbound + inbound mail
    llm/           LlmProvider     — streaming chat + usage/budget
    secrets/       SecretCipher    — encrypt-at-rest
    auth/          AuthProvider    — OAuth 2.1 resource-server identity
    storage/       BlobStore       — object storage
  mcp/             MCP server front door (Phase 4) — peer to the CLI
deploy/
  local/           docker-compose (default target)
  aws/             terraform (native cloud target)
prisma/            schema + migrations (hand-written from spec)
```

Providers are selected purely by environment variable — e.g.
`JOB_LAUNCHER=local`, `EMAIL_PROVIDER=smtp`, `SECRET_CIPHER=app-key`. Swapping to
a native cloud deployment is configuration, not a code change.

The `llm/` provider is the one exception: it's not a single-adapter switch but
a per-agent **model router**. An OpenAI adapter and a direct Anthropic (Claude)
adapter each register for the model names they own; whichever adapters have
credentials present (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) are enabled, and an
agent's `model` field picks which adapter handles its calls — so OpenAI and
Claude agents can run side by side in one deployment. Bedrock-hosted Claude is
a reserved `LLM_PROVIDER` kind with no adapter yet.

## MCP server (Phase 4)

`reevo mcp` exposes agents, tools, scheduling, runs, datastore, secrets, and
webhooks as MCP tools — the primary way to author and operate agents, with
the CLI retained only as the bootstrap/ops floor (`migrate`, `scheduler`,
`run`, `runs`). Two transports:

- **stdio** (`MCP_TRANSPORT=stdio`, default) — local, no OAuth; the operator
  is trusted, and `LOCAL_PRINCIPAL` names the owner identity for anything
  authored this way.
- **Streamable HTTP** (`MCP_TRANSPORT=http`) — remote, always an OAuth 2.1
  resource server. `AUTH_PROVIDER=delegating` (default) verifies tokens
  issued by an external IdP. `AUTH_PROVIDER=self-hosted` uses provisioned users,
  browser login and consent, public clients, and S256 PKCE.

Long-running operations (`trigger_agent`) return a durable Task (the MCP
Tasks extension) when the client supports it, falling back to a plain
`{runId}` polled via `get_run` otherwise — either way the same engine and
budget guardrail run underneath. See `.env.example` for the full set of
`MCP_*`/`AUTH_*`/`SECRET_*` configuration keys.

Use Node.js 22.12 or newer. See [security deployment and recovery](docs/security-deployment.md)
for HTTP boundaries, self-hosted provisioning, credential
invalidation, runtime/migration images, test prerequisites, and the remaining
Prisma tooling advisory. Every legacy self-hosted credential must be reissued.

## Durable executor (Phase 6)

`EXECUTOR=in-process` (default) provides durability with a heartbeat and a
reconciler: a run whose process dies is reconciled to `lost`.

`EXECUTOR=dbos` runs each native agent run as a [DBOS](https://docs.dbos.dev)
durable workflow. Every LLM turn and tool call is a checkpointed step, so a
run interrupted by a crash or redeploy resumes from its last completed step
with no repeated spend for finished turns, and cancelling a run
(`tasks/cancel`, `stop`) takes effect at the next step — the run lands
`cancelled` with the caller's own reason. DBOS keeps its tables in the `dbos`
schema of `DATABASE_URL` (override with `DBOS_SYSTEM_DATABASE_URL`).
`DBOS_EXECUTOR_ID` is **required** and must be unique per running process
(the scheduler and the MCP server need different values): a process re-drives
every interrupted run its own id owns at startup, so two processes sharing an
id each re-drive the other's live workflows. A stale run owned by an instance
that never returns is adopted by whichever reconciler sees it first. The
at-least-once window is one step: a turn that was mid-stream when the process
died runs again on resume — and the partial spend of that interrupted step is
not recorded, so a resumed run's `costUsd` can under-count what the provider
actually charged.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Built as an independent reimplementation; see [CLEANROOM.md](CLEANROOM.md).
