-- A run's current DBOS workflow when a cross-version takeover forked it (null = the run id),
-- and the delegation call that created a child run.
ALTER TABLE "Run" ADD COLUMN "executionWorkflowId" TEXT;
ALTER TABLE "Run" ADD COLUMN "parentCallId" TEXT;

CREATE UNIQUE INDEX "Run_parentRunId_parentCallId_key" ON "Run"("parentRunId", "parentCallId");
