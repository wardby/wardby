-- Additive: per-link opt-in to reviewing every push to an open pull request; the default reviews on open/ready only.
-- Existing links take the default too.
ALTER TABLE "AgentRepository" ADD COLUMN "reviewOnPush" BOOLEAN NOT NULL DEFAULT false;
