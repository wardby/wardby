-- Send-to-agent: when a thread's sent run is a reconcile run (it re-applies an
-- earlier run's edit that conflicted with a newer version), the earlier run's
-- id. At most one reconcile per send: a reconcile run that conflicts again is
-- never reconciled again. A new send clears it.
ALTER TABLE "CommentThread" ADD COLUMN "reconcileOfRunId" TEXT;
