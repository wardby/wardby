-- Substrate warm rounds (SUBSTRATE_WARM_ROUNDS): what a parked run was parked with, the round its
-- actors are on, and the agent it belongs to; whether a coding run resumed a parked round.
ALTER TABLE "SubstrateRun" ADD COLUMN "headSha" TEXT;
ALTER TABLE "SubstrateRun" ADD COLUMN "fingerprint" TEXT;
ALTER TABLE "SubstrateRun" ADD COLUMN "parkedAt" TIMESTAMP(3);
ALTER TABLE "SubstrateRun" ADD COLUMN "round" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "SubstrateRun" ADD COLUMN "agentId" TEXT;

CREATE INDEX "SubstrateRun_phase_parkedAt_idx" ON "SubstrateRun"("phase", "parkedAt");
CREATE INDEX "SubstrateRun_agentId_phase_idx" ON "SubstrateRun"("agentId", "phase");

ALTER TABLE "CodingRun" ADD COLUMN "warmStart" BOOLEAN;
