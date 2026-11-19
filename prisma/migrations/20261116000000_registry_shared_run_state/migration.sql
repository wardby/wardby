-- Package registry per-run state moves out of proxy process memory so any
-- proxy replica can serve any request of a run.
ALTER TABLE "CodingProxySession" ADD COLUMN "registryPlanFallback" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "registryPlans" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "registryPlanLeaseUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RegistryReservation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistryReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RegistryReservation_runId_idx" ON "RegistryReservation"("runId");

-- AddForeignKey
ALTER TABLE "RegistryReservation" ADD CONSTRAINT "RegistryReservation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CodingProxySession"("runId") ON DELETE CASCADE ON UPDATE CASCADE;
