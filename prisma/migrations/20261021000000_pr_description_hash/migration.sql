-- Additive: the pull request description Wardby last wrote (hash + author run, root rows only), and each run's description update outcome.
ALTER TABLE "CodingRun" ADD COLUMN "prDescriptionSha256" TEXT;
ALTER TABLE "CodingRun" ADD COLUMN "prDescriptionRunId" TEXT;
ALTER TABLE "CodingRun" ADD COLUMN "prDescriptionOutcome" TEXT;
