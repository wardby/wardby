-- Session resume: per-agent setting, per-run copy, and transcript metadata.
ALTER TABLE "CodingAgentProfile" ADD COLUMN "sessionResume" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CodingRun" ADD COLUMN "sessionResume" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "RunTranscript" (
    "runId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "sessionId" TEXT,
    "blobKey" TEXT,
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RunTranscript_pkey" PRIMARY KEY ("runId")
);

CREATE INDEX "RunTranscript_expiresAt_idx" ON "RunTranscript"("expiresAt");

ALTER TABLE "RunTranscript" ADD CONSTRAINT "RunTranscript_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
