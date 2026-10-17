# Architecture knowledge

## Overviews

- [MCP management and authorization](overview-mcp.md) — Transport identity becomes scoped management calls over owned resources and explicit grants.
- [Configuration and process bootstrap](overview-config.md) — Environment loading precedes typed feature settings and provider composition.
- [Run admission and execution](overview-core.md) — Dispatch persists admitted work before executors drive native or coding runs and recovery settles orphans.
- [Coding inputs and isolated workers](overview-coding.md) — Shared protocols connect trusted run preparation to Codex or Claude Code workers and host finalization.
- [Coding proxy and package mediation](overview-coding-proxy.md) — Run capabilities gate model reservations, package policy and optional dependency snapshots.
- [Native tool and worker isolation](overview-sandbox.md) — QuickJS evaluates user tools while a run-bound gateway retains privileged effects and native worker authority.
- [Provider composition and routing](overview-providers.md) — Interfaces separate orchestration from concrete model, execution, identity, persistence and source-control adapters.
- [Durable data and migration boundaries](overview-prisma.md) — Relational definitions and migrations persist identity, run lifecycle, accounting and integration state.
- [Deployment topology and infrastructure](overview-deploy.md) — Terraform, Compose and Kubernetes assets connect trusted services to isolated workers and durable storage.
- [CLI bootstrap and bundle import](overview-cli.md) — Command entry points assemble local installations, invoke runtime services and reconcile imported resources.
- [Viewer, observability and knowledge tooling](overview-surfaces.md) — Read projections, metrics and cited knowledge expose runtime state and architecture without owning execution.

## Invariants

- [HTTP compatibility depends on bootstrap order](http-dispatcher-bootstrap.md) — A Kubernetes client import can change built-in fetch behavior even when jobs use Docker.
- [Pricing races must use the persisted winner](run-pricing-first-writer.md) — Concurrent native attempts must reuse the catalog terms that won the conditional pricing write.
- [Private datastore wrappers must reject shared methods](private-datastore-shared-boundary.md) — Prefix restrictions on private keys cannot authorize the provider shared-store methods.
- [Failed workspace fills must remain untrusted](workspace-staging-failure.md) — Collection failure must not expose a partially materialized worker tree to validation or trusted replacement.
- [Import rename targets must be checked before creation](import-rename-target.md) — Renaming a colliding entity onto another existing name would silently adopt that entity through idempotent creation.
- [Viewer notifications must not abort authoritative writes](viewer-notify-write-isolation.md) — The viewer trigger contains notification errors so event delivery cannot fail run persistence.
- [Blob absence must distinguish missing infrastructure](blob-not-found-semantics.md) — Mapping a storage outage to not_found can delete valid dependency snapshot metadata.
- [Warm input publication must refuse replacement](warm-input-publication.md) — Atomic visibility alone is insufficient when one warm worker may receive its capability only once.
- [Proxy usage projections must not govern settlement](proxy-settlement-projections.md) — Run totals are rebuilt from settled requests while per-model reporting failures are isolated by a savepoint.
- [Untrusted file bounds belong to the open descriptor](bounded-file-descriptor.md) — Checking a path before reading it leaves file substitution and growth races across worker boundaries.
- [Agent authorization must share the mutation transaction](transactional-agent-authorization.md) — Using the default access client inside a transaction disconnects grant reads from mutation isolation.
- [Budget-waiting delegations retain admission slots](delegation-admission-slots.md) — Releasing the delegation gate during a budget wait must preserve duplicate-child and delegation-limit accounting.
- [Schedule deduplication belongs to the transaction](schedule-claim-transaction.md) — A scheduler lease cannot replace the atomic schedule-window claim and run creation.
- [Terminal run state belongs to the first writer](terminal-run-first-writer.md) — Run completion must conditionally write pending or running rows and read back the persisted winner.
- [Task cancellation takes precedence over run status](mcp-cancelled-task-precedence.md) — A cancelled task remains cancelled even if its underlying run finishes with a different terminal outcome.
- [Secret entry replicas must share token verification](secret-entry-replica-contract.md) — A shared outcome database cannot complete a secret-entry round trip when replicas use independent signing keys.

## Decisions

- [MCP schemas cross the SDK boundary as JSON](mcp-schema-module-boundary.md) — Using the SDK schema converter avoids incompatible Zod instances at tool registration.

## Pitfalls

- [Nullable tool ownership leaves a uniqueness gap](nullable-tool-uniqueness.md) — The owner-and-name unique index does not deduplicate ownerless tools in PostgreSQL.
- [HTTP prompt discovery cannot use per-call identity](mcp-http-prompt-discovery.md) — The HTTP factory exposes everyone-readable agent prompts rather than the authenticated caller’s full agent set.

## Coverage

1. src/mcp/ (tools, auth, access, grants): covered 2026-10-17 (6 concepts)
2. src/config/ and env handling: covered 2026-10-17 (2 concepts)
3. src/core/ runner, scheduler, dispatch, budgets, delegation: covered 2026-10-17 (7 concepts)
4. src/coding/ and src/coding-worker/, src/claude-*/ (coding runs, workers): covered 2026-10-17 (2 concepts)
5. src/providers/coding-proxy/ (proxy, package registry): covered 2026-10-17 (3 concepts)
6. src/sandbox/ and src/native-worker/ (native sandbox, isolation): covered 2026-10-17 (3 concepts)
7. src/providers/ other seams (LLM, auth, storage, VCS, executors): covered 2026-10-17 (7 concepts)
8. prisma/ (schema, migrations): covered 2026-10-17 (3 concepts)
9. deploy/ (Terraform, Kubernetes, scripts): covered 2026-10-17 (2 concepts)
10. src/quickstart/, src/import/, the CLI files in src/: covered 2026-10-17 (4 concepts)
11. src/viewer/, src/observability/, src/knowledge/, src/tools/: covered 2026-10-17 (2 concepts)
