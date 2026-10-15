# Architecture knowledge

## Invariants

- [Agent authorization must share the mutation transaction](transactional-agent-authorization.md) — Using the default access client inside a transaction disconnects grant reads from mutation isolation.
- [Budget-waiting delegations retain admission slots](delegation-admission-slots.md) — Releasing the delegation gate during a budget wait must preserve duplicate-child and delegation-limit accounting.
