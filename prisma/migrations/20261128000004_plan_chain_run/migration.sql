-- Plan build chain (C3 fix round): the ticket run the chain follows, and the principal whose
-- verdict completed the approval (the starter recorded on every ticket run the approval starts).
ALTER TABLE "PlanSet" ADD COLUMN "chainRunId" TEXT;
ALTER TABLE "PlanSet" ADD COLUMN "approvedById" TEXT;
