-- Package registry: ecosystems where a run sent a lockfile the plan could not
-- read, so the status comments and get_run can say nothing was checked ahead.
ALTER TABLE "CodingProxySession" ADD COLUMN "registryPlanUnchecked" TEXT[] DEFAULT ARRAY[]::TEXT[];
