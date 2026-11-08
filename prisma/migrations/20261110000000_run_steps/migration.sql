-- Run steps: one line per tool call or model message, and the count of steps past the per-run cap.
ALTER TABLE "Run" ADD COLUMN "stepsDropped" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "RunStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "tool" TEXT,
    "callId" TEXT,
    "summary" TEXT NOT NULL,
    "status" TEXT,
    "detail" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RunStep_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RunStep_runId_seq_key" ON "RunStep"("runId", "seq");

CREATE INDEX "RunStep_runId_callId_idx" ON "RunStep"("runId", "callId");

CREATE INDEX "RunStep_expiresAt_idx" ON "RunStep"("expiresAt");

ALTER TABLE "RunStep" ADD CONSTRAINT "RunStep_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
