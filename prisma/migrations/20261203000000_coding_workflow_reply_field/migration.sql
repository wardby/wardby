-- Coding workflows (#582): the field of a workflow script's result that is the run's reply.
ALTER TABLE "CodingAgentProfile" ADD COLUMN "workflowReplyField" TEXT;
ALTER TABLE "CodingRun" ADD COLUMN "workflowReplyField" TEXT;
