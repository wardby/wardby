# Architecture knowledge

## Invariants

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

1. src/mcp/ (tools, auth, access, grants): covered 2026-10-15 (5 concepts)
2. src/config/ and env handling: covered 2026-10-15 (0 concepts)
3. src/core/ runner, scheduler, dispatch, budgets, delegation: covered 2026-10-15 (3 concepts)
4. src/coding/ and src/coding-worker/, src/claude-*/ (coding runs, workers): covered 2026-10-16 (1 concept)
5. src/providers/coding-proxy/ (proxy, package registry): covered 2026-10-16 (2 concepts)
6. src/sandbox/ and src/native-worker/ (native sandbox, isolation): covered 2026-10-16 (1 concept)
7. src/providers/ other seams (LLM, auth, storage, VCS, executors): covered 2026-10-16 (2 concepts)
8. prisma/ (schema, migrations): covered 2026-10-16 (2 concepts)
9. deploy/ (Terraform, Kubernetes, scripts): covered 2026-10-16 (1 concept)
10. src/quickstart/, src/import/, the CLI files in src/: covered 2026-10-16 (2 concepts)
11. src/viewer/, src/observability/, src/knowledge/, src/tools/: covered 2026-10-16 (1 concept)
