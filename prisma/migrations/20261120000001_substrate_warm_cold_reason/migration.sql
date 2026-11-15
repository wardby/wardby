-- Substrate warm rounds: why a continuation launched on a fresh sandbox instead of adopting the
-- parked one (a fixed code; null for a run that adopted, or that continued nothing).
ALTER TABLE "SubstrateRun" ADD COLUMN "coldReason" TEXT;
