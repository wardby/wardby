# Architecture knowledge

## Invariants

- [Agent authorization must share the mutation transaction](transactional-agent-authorization.md) — Using the default access client inside a transaction disconnects grant reads from mutation isolation.
- [Budget-waiting delegations retain admission slots](delegation-admission-slots.md) — Releasing the delegation gate during a budget wait must preserve duplicate-child and delegation-limit accounting.
- [Schedule deduplication belongs to the transaction](schedule-claim-transaction.md) — A scheduler lease cannot replace the atomic schedule-window claim and run creation.
- [Terminal run state belongs to the first writer](terminal-run-first-writer.md) — Run completion must conditionally write pending or running rows and read back the persisted winner.
