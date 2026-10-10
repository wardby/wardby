-- Additive: a deferred review can wait for the delegating lead run, not just CI.
ALTER TABLE "DeferredReview" ADD COLUMN "reason" TEXT NOT NULL DEFAULT 'ci',
ADD COLUMN "leadRunId" TEXT;
CREATE INDEX "DeferredReview_leadRunId_idx" ON "DeferredReview"("leadRunId");
