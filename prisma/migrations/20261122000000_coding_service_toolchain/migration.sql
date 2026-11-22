-- Toolchain services (#599): a team image the run's commands are forwarded to.
ALTER TABLE "CodingService" ADD COLUMN "setupCommand" JSONB;
ALTER TABLE "CodingService" ALTER COLUMN "dataPath" DROP NOT NULL;
-- A toolchain has no port or readiness command either (both are refused for one).
ALTER TABLE "CodingService" ALTER COLUMN "port" DROP NOT NULL;
ALTER TABLE "CodingService" ALTER COLUMN "readiness" DROP NOT NULL;
