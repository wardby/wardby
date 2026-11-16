-- Native sandbox: record when a run's worker was removed, so a launcher with no worker list
-- (NATIVE_SANDBOX_LAUNCHER=substrate) can sweep leftovers from the sessions.
ALTER TABLE "NativeGatewaySession" ADD COLUMN "workerRemovedAt" TIMESTAMP(3);
-- Sessions that ended before this column existed had their workers removed by their own launcher.
UPDATE "NativeGatewaySession" SET "workerRemovedAt" = "updatedAt" WHERE "status" <> 'active';

-- The row sweep runs every minute and looks for the rows where this is null.
CREATE INDEX "NativeGatewaySession_workerRemovedAt_idx" ON "NativeGatewaySession"("workerRemovedAt");
