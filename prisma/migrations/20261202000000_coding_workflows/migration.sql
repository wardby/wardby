-- Coding workflows (#582): an agent's workflow script, and the workflow fixed on each run.
ALTER TABLE "CodingAgentProfile" ADD COLUMN "workflowName" TEXT;
ALTER TABLE "CodingAgentProfile" ADD COLUMN "workflowRepository" TEXT;

ALTER TABLE "CodingRun" ADD COLUMN "workflowName" TEXT;
ALTER TABLE "CodingRun" ADD COLUMN "workflowRepository" TEXT;
ALTER TABLE "CodingRun" ADD COLUMN "workflowArgs" JSONB;
