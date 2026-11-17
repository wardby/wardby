-- Plan publishing: a lease on the set (the run holding it and until when) instead of a lock held
-- in a transaction, so a publish holds no connection while it waits or works.
ALTER TABLE "PlanSet" ADD COLUMN "publishLeaseRunId" TEXT;
ALTER TABLE "PlanSet" ADD COLUMN "publishLeaseUntil" TIMESTAMP(3);
