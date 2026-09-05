# reevo-run

Schedule and run **budget-guarded LLM agents** — autonomous agents that run on a
schedule or in response to events, with hard spend limits that stop *before*
cost, and a sandboxed tool executor.

> Reevo runs your agents on a schedule, within a budget.

## Status

Early scaffold. The provider-seam architecture and interface contracts are in
place; adapters and the core engine are being built out.

## Architecture at a glance

reevo-run is a **cloud-agnostic core** with swappable **provider seams**. The
core never imports a cloud SDK; each external dependency sits behind an
interface with a default (portable) adapter and optional native adapters.

```
src/
  core/            cloud-agnostic domain: agents, tools, runner, scheduler,
                   triggers, sandbox (built out in later steps)
  config/          provider selection from environment
  providers/
    jobs/          JobLauncher     — dispatch long-running work
    email/         EmailProvider   — outbound + inbound mail
    llm/           LlmProvider     — streaming chat + usage/budget
    secrets/       SecretCipher    — encrypt-at-rest
    auth/          AuthProvider    — OIDC identity + roles
    storage/       BlobStore       — object storage
deploy/
  local/           docker-compose (default target)
  aws/             terraform (native cloud target)
prisma/            schema + migrations (hand-written from spec)
```

Providers are selected purely by environment variable — e.g.
`JOB_LAUNCHER=local`, `EMAIL_PROVIDER=smtp`, `SECRET_CIPHER=app-key`. Swapping to
a native cloud deployment is configuration, not a code change.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Built as an independent reimplementation; see [CLEANROOM.md](CLEANROOM.md).
