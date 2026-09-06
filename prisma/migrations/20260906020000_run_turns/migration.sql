-- Hand-written per CLEANROOM.md (never `db push`, never generated from
-- another project's migrations). Additive: Run.turns, so a run's turn
-- count is durably readable (previously only returned in EngineResult and
-- dropped) — needed by Phase 4's list_runs/get_run MCP tools.

ALTER TABLE "Run" ADD COLUMN "turns" INTEGER NOT NULL DEFAULT 0;
