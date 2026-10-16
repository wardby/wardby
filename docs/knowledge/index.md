# Architecture knowledge

## Invariants

- [Agent authorization must share the mutation transaction](transactional-agent-authorization.md) — Using the default access client inside a transaction disconnects grant reads from mutation isolation.
- [Budget-waiting delegations retain admission slots](delegation-admission-slots.md) — Releasing the delegation gate during a budget wait must preserve duplicate-child and delegation-limit accounting.
- [Schedule deduplication belongs to the transaction](schedule-claim-transaction.md) — A scheduler lease cannot replace the atomic schedule-window claim and run creation.
- [Terminal run state belongs to the first writer](terminal-run-first-writer.md) — Run completion must conditionally write pending or running rows and read back the persisted winner.
- [Task cancellation takes precedence over run status](mcp-cancelled-task-precedence.md) — A cancelled task remains cancelled even if its underlying run finishes with a different terminal outcome.
- [Secret entry replicas must share token verification](secret-entry-replica-contract.md) — A shared outcome database cannot complete a secret-entry round trip when replicas use independent signing keys.

## Decisions

- [MCP schemas cross the SDK boundary as JSON](mcp-schema-module-boundary.md) — Using the SDK schema converter avoids incompatible Zod instances at tool registration.

## Pitfalls

- [HTTP prompt discovery cannot use per-call identity](mcp-http-prompt-discovery.md) — The HTTP factory exposes everyone-readable agent prompts rather than the authenticated caller’s full agent set.

## Coverage

1. src/mcp/ (tools, auth, access, grants): covered 2026-10-15 (5 concepts)
2. src/config/ and env handling: covered 2026-10-15 (0 concepts)
3. src/core/ runner, scheduler, dispatch, budgets, delegation: covered 2026-10-15 (3 concepts)
4. src/coding/ and src/coding-worker/, src/claude-*/ (coding runs, workers): not yet covered
5. src/providers/coding-proxy/ (proxy, package registry): not yet covered
6. src/sandbox/ and src/native-worker/ (native sandbox, isolation): not yet covered
7. src/providers/ other seams (LLM, auth, storage, VCS, executors): not yet covered
8. prisma/ (schema, migrations): not yet covered
9. deploy/ (Terraform, Kubernetes, scripts): not yet covered
10. src/quickstart/, src/import/, the CLI files in src/: not yet covered
11. src/viewer/, src/observability/, src/knowledge/, src/tools/: not yet covered
