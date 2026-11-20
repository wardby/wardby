-- The branch and commit a continuation's workspace merged from its pull request's target branch,
-- recorded with the job handle (baseSha, already there, is the commit the clone started from).
-- Another control-plane process that finishes the run rebuilds the checkout from these two and
-- baseSha when the launching process's local copy is gone. Additive only: nullable columns.

ALTER TABLE "CodingRun" ADD COLUMN "targetMergeRef" TEXT,
ADD COLUMN "targetMergeSha" TEXT;
