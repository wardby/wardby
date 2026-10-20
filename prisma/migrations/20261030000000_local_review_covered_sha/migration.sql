-- The head a local review read every file of (null when it did not): repo_pr_read's lastCoveredSha.
ALTER TABLE "LocalReview" ADD COLUMN "coveredSha" TEXT;
