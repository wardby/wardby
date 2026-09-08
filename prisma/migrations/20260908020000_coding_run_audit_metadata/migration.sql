-- Metadata-only coding failure audit fields. Detailed diagnostics belong in the
-- protected log sink; task text, diffs, and credentials never enter this table.
ALTER TABLE "CodingRun"
  ADD COLUMN "failureCategory" TEXT,
  ADD COLUMN "diagnosticId" TEXT;

CREATE INDEX "CodingRun_failureCategory_idx" ON "CodingRun"("failureCategory");
