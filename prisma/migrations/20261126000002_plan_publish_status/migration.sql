-- Plan publishing: a per-run completion marker, and one document per plan path in a set.
ALTER TABLE "CodingRun" ADD COLUMN "planPublishStatus" TEXT;

-- NULLs are distinct in Postgres, so documents outside a plan set (planSetId NULL) are unaffected.
CREATE UNIQUE INDEX "Document_planSetId_planPath_key" ON "Document"("planSetId", "planPath");
