-- Coding workflows (#582): an agent's workflow script, and the workflow fixed on each run.
ALTER TABLE "CodingAgentProfile" ADD COLUMN "workflowName" TEXT;
ALTER TABLE "CodingAgentProfile" ADD COLUMN "workflowRepository" TEXT;

ALTER TABLE "CodingRun" ADD COLUMN "workflowName" TEXT;
ALTER TABLE "CodingRun" ADD COLUMN "workflowRepository" TEXT;
ALTER TABLE "CodingRun" ADD COLUMN "workflowArgs" JSONB;

-- The proxy session of a workflow run: the only sessions whose requests may use the Workflow tool.
ALTER TABLE "CodingProxySession" ADD COLUMN "workflow" BOOLEAN NOT NULL DEFAULT false;
