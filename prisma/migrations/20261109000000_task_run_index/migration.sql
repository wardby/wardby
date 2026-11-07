-- The run-drivability and cancelled-task lookups filter Task on (runId, status); the drivability
-- check runs on every coding MCP request.
CREATE INDEX "Task_runId_status_idx" ON "Task"("runId", "status");
