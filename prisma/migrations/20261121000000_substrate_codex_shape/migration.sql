-- Substrate Codex runs: a run's actor shape (pair = agent + tool, single = one actor).
ALTER TABLE "SubstrateRun" ADD COLUMN "actorShape" TEXT NOT NULL DEFAULT 'pair';
