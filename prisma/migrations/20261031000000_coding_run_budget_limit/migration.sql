-- Overrun from available room: a coding run reserves its base budget, and may
-- spend past it up to the limit recorded here only through top-ups its budget
-- group and run tree have room for. Null = no top-ups (older runs, or no
-- allowed overrun): the reservation is the run's limit, as before.
ALTER TABLE "CodingRun" ADD COLUMN "budgetLimitUsd" DECIMAL(10,6);

-- A top-up the group or run tree had no room for. Postgres 12+ allows ADD VALUE
-- inside a transaction as long as the new value is not used in the same one.
ALTER TYPE "RunBudgetEventKind" ADD VALUE 'overrun_unavailable';
