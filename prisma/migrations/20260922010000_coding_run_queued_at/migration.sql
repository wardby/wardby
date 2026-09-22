-- Additive: Phase 12 coding concurrency queue. See
-- docs/superpowers/specs/2026-09-22-phase-12-kubernetes-job-launcher-design.md §6.

-- AlterTable
ALTER TABLE "CodingRun" ADD COLUMN     "queuedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "CodingRun_queuedAt_idx" ON "CodingRun"("queuedAt");
