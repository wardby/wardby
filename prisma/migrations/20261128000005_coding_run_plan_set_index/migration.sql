-- Builder runs are looked up by their plan set (chain checks, one run at a time per plan).
CREATE INDEX "CodingRun_planSetId_idx" ON "CodingRun"("planSetId");
