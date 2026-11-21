-- Coding workflows (#582): run steps grouped by the workflow's phases and sub-agents.
ALTER TABLE "RunStep" ADD COLUMN "agentRef" TEXT;
ALTER TABLE "CodingRun" ADD COLUMN "workflowProgress" JSONB;
