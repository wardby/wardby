-- Phase 5 coding-agent schema. Additive defaults preserve all existing agents
-- as native and all existing runs as managed by their historical execution path.
BEGIN;

CREATE TYPE "AgentKind" AS ENUM ('native', 'coding');
CREATE TYPE "CodingProvider" AS ENUM ('codex');
ALTER TYPE "RunStatus" ADD VALUE 'cancelled';

ALTER TABLE "Agent"
  ADD COLUMN "kind" "AgentKind" NOT NULL DEFAULT 'native';

ALTER TABLE "Run"
  ADD COLUMN "executionManaged" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "CodingAgentProfile" (
  "agentId" TEXT PRIMARY KEY,
  "provider" "CodingProvider" NOT NULL DEFAULT 'codex',
  "repository" TEXT NOT NULL,
  "baseRef" TEXT NOT NULL DEFAULT 'main',
  "defaultTask" TEXT,
  "timeoutSec" INTEGER NOT NULL DEFAULT 1800,
  "allowedEgress" JSONB NOT NULL,
  "protectedPaths" JSONB NOT NULL,
  CONSTRAINT "CodingAgentProfile_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CodingRun" (
  "runId" TEXT PRIMARY KEY,
  "task" TEXT NOT NULL,
  "repository" TEXT NOT NULL,
  "baseRef" TEXT NOT NULL,
  "headRef" TEXT NOT NULL,
  "provider" "CodingProvider" NOT NULL,
  "model" TEXT NOT NULL,
  "timeoutSec" INTEGER NOT NULL,
  "allowedEgress" JSONB NOT NULL,
  "protectedPaths" JSONB NOT NULL,
  "jobBackend" TEXT,
  "jobHandle" TEXT,
  "result" JSONB,
  "resultSchema" INTEGER NOT NULL DEFAULT 1,
  "budgetReservedUsd" DECIMAL(10,6) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CodingRun_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "CodingRun_jobBackend_jobHandle_idx" ON "CodingRun"("jobBackend", "jobHandle");

COMMIT;
