-- The status comment posted for a mention-started run, edited with its outcome.

-- CreateTable
CREATE TABLE "RunHostStatus" (
    "runId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "commentKind" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RunHostStatus_pkey" PRIMARY KEY ("runId")
);

-- AddForeignKey
ALTER TABLE "RunHostStatus" ADD CONSTRAINT "RunHostStatus_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
