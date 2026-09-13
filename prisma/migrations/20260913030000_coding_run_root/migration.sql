-- Additive: revision-in-place continuation link. See
-- docs/private/2026-09-13-coding-pr-revision-in-place-design.md.

-- AlterTable
ALTER TABLE "CodingRun" ADD COLUMN     "rootCodingRunId" TEXT;

-- CreateIndex
CREATE INDEX "CodingRun_rootCodingRunId_idx" ON "CodingRun"("rootCodingRunId");

-- AddForeignKey
ALTER TABLE "CodingRun" ADD CONSTRAINT "CodingRun_rootCodingRunId_fkey" FOREIGN KEY ("rootCodingRunId") REFERENCES "CodingRun"("runId") ON DELETE SET NULL ON UPDATE CASCADE;
