-- Hand-written per CLEANROOM.md (never `db push`, never generated from
-- another project's migrations). Additive: Run.finalText, so a completed
-- run's answer is durably readable (previously only streamed live via
-- onText and dropped) — needed by Phase 4's Task manager (MCP) to answer
-- `tasks/get`/`get_run` for a succeeded run.

ALTER TABLE "Run" ADD COLUMN "finalText" TEXT;
