-- Additive: per-link opt-in to review draft pull requests; the default skips them.
ALTER TABLE "AgentRepository" ADD COLUMN "reviewDrafts" BOOLEAN NOT NULL DEFAULT false;
