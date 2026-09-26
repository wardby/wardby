-- Additive: the exact versions a run's lockfile plan definitively refused,
-- so a download of one is answered from the plan (no graph walk). See
-- docs/coding-packages.md.

-- CreateTable
CREATE TABLE "RegistryPlanRefusal" (
    "runId" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistryPlanRefusal_pkey" PRIMARY KEY ("runId","ecosystem","name","version")
);

-- AddForeignKey
ALTER TABLE "RegistryPlanRefusal" ADD CONSTRAINT "RegistryPlanRefusal_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CodingRun"("runId") ON DELETE CASCADE ON UPDATE CASCADE;
