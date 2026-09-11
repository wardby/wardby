ALTER TABLE "CodingAgentProfile" ADD COLUMN "toolchain" TEXT NOT NULL DEFAULT 'node';
ALTER TABLE "CodingAgentProfile" ADD COLUMN "toolchainVersion" TEXT;
ALTER TABLE "CodingAgentProfile" ADD COLUMN "workerImageRef" TEXT;

ALTER TABLE "CodingRun" ADD COLUMN "workerImage" TEXT;
