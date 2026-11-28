-- Native agents get a run time limit (join phase 2): the agent's setting, and each run's copy of it.
ALTER TABLE "Agent" ADD COLUMN "timeoutSec" INTEGER NOT NULL DEFAULT 1800;
ALTER TABLE "Run" ADD COLUMN "timeoutSec" INTEGER;
