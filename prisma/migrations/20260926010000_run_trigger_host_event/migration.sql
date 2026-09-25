-- Additive: a run started by a code-review host event (GitHub App webhook).
-- Its own migration: Postgres cannot use a newly added enum value in the
-- same transaction that adds it. See
-- docs/private/2026-09-25-code-review-host-design.md §4.

-- AlterEnum
ALTER TYPE "RunTrigger" ADD VALUE 'host_event';
