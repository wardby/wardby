-- Substrate warm rounds (SUBSTRATE_WARM_ROUNDS): what a parked run was parked with, the round its
-- actors are on, the agent it belongs to, and why a continuation launched on a fresh sandbox
-- instead of adopting the parked one (a fixed code; null for a run that adopted, or that continued
-- nothing). A coding run records whether it resumed a parked round and the agent fingerprint it
-- launched with, so a delivered round is retained under the value it ran with and a restarted
-- control plane reads the same value (null = warm rounds off or not computed).
ALTER TABLE "SubstrateRun" ADD COLUMN "headSha" TEXT;
ALTER TABLE "SubstrateRun" ADD COLUMN "fingerprint" TEXT;
ALTER TABLE "SubstrateRun" ADD COLUMN "parkedAt" TIMESTAMP(3);
ALTER TABLE "SubstrateRun" ADD COLUMN "round" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "SubstrateRun" ADD COLUMN "agentId" TEXT;
ALTER TABLE "SubstrateRun" ADD COLUMN "coldReason" TEXT;

CREATE INDEX "SubstrateRun_phase_parkedAt_idx" ON "SubstrateRun"("phase", "parkedAt");
CREATE INDEX "SubstrateRun_agentId_phase_idx" ON "SubstrateRun"("agentId", "phase");

ALTER TABLE "CodingRun" ADD COLUMN "warmStart" BOOLEAN;
ALTER TABLE "CodingRun" ADD COLUMN "warmFingerprint" TEXT;
