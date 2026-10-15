# Architecture knowledge

## Invariants

- [Schedule deduplication belongs to the transaction](schedule-claim-transaction.md) — A scheduler lease cannot replace the atomic schedule-window claim and run creation.
- [Terminal run state belongs to the first writer](terminal-run-first-writer.md) — Run completion must conditionally write pending or running rows and read back the persisted winner.
- [Parallel delegations serialize admission until persistence](delegation-admission-gate.md) — Hold the per-attempt gate through limit checks and child persistence, then release it before waiting for execution.
