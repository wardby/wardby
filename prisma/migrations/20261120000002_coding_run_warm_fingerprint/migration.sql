-- Substrate warm rounds: the agent fingerprint a coding run launched with, so a delivered round is
-- retained under the value it ran with (not one recomputed at finish) and a restarted control plane
-- reads the same value. Null = warm rounds off or not computed.
ALTER TABLE "CodingRun" ADD COLUMN "warmFingerprint" TEXT;
