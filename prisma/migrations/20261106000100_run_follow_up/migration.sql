-- A durable outbox for the chores that follow a run's terminal status (stopping child runs,
-- notifications, a PR comment). A row is written in the same transaction as the status, so a crash
-- between the two cannot lose it; the scheduler leader drains the due rows. Additive only.

CREATE TABLE "RunFollowUp" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunFollowUp_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RunFollowUp_doneAt_nextAttemptAt_idx" ON "RunFollowUp"("doneAt", "nextAttemptAt");

CREATE UNIQUE INDEX "RunFollowUp_runId_kind_key" ON "RunFollowUp"("runId", "kind");

ALTER TABLE "RunFollowUp" ADD CONSTRAINT "RunFollowUp_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
