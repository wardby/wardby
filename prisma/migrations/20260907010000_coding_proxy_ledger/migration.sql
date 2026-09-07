-- Durable, monotonic accounting for the Phase 5 per-run credential proxy.
-- Capability and provider secrets are deliberately absent: only a SHA-256
-- capability digest and an operator-defined credential reference are stored.
BEGIN;

CREATE TYPE "CodingProxySessionStatus" AS ENUM ('active', 'cancelled');
CREATE TYPE "CodingProxyRequestStatus" AS ENUM ('reserved', 'completed', 'released', 'uncertain');

CREATE TABLE "CodingProxySession" (
  "id" TEXT PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "capabilityHash" TEXT NOT NULL,
  "credentialRef" TEXT NOT NULL,
  "allowedModels" JSONB NOT NULL,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "budgetUsd" DECIMAL(18,10) NOT NULL,
  "status" "CodingProxySessionStatus" NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CodingProxySession_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "CodingRun"("runId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CodingProxySession_runId_key" ON "CodingProxySession"("runId");
CREATE UNIQUE INDEX "CodingProxySession_capabilityHash_key" ON "CodingProxySession"("capabilityHash");
CREATE INDEX "CodingProxySession_deadlineAt_idx" ON "CodingProxySession"("deadlineAt");

CREATE TABLE "CodingProxyRequest" (
  "id" TEXT PRIMARY KEY,
  "sessionId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "status" "CodingProxyRequestStatus" NOT NULL DEFAULT 'reserved',
  "reservationUsd" DECIMAL(18,10) NOT NULL,
  "actualCostUsd" DECIMAL(18,10),
  "pricingVersion" TEXT NOT NULL,
  "pricingSnapshot" JSONB NOT NULL,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "cachedInputTokens" INTEGER,
  "cacheWriteTokens" INTEGER,
  "reasoningTokens" INTEGER,
  "upstreamStatus" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "CodingProxyRequest_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "CodingProxySession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CodingProxyRequest_sessionId_requestKey_key"
  ON "CodingProxyRequest"("sessionId", "requestKey");
CREATE INDEX "CodingProxyRequest_sessionId_status_idx"
  ON "CodingProxyRequest"("sessionId", "status");

COMMIT;
