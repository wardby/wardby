-- Per-agent allowed overrun (percent above budgetUsd) for coding runs, and the
-- pre-overrun budget recorded on each coding run.
ALTER TABLE "Agent" ADD COLUMN "allowedOverrunPercent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CodingRun" ADD COLUMN "budgetBaseUsd" DECIMAL(10,6);
