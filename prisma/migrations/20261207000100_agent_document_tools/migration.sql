-- Built-in doc_* tools for native agents (#625).
ALTER TABLE "Agent" ADD COLUMN "documentTools" JSONB;

-- An agent's doc_submit_for_review records its run.
ALTER TABLE "DocumentReviewEvent" ADD COLUMN "actorRunId" TEXT;
