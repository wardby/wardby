-- Additive: per-link choice of whether a pull request is reviewed automatically when opened, reopened or marked ready.
-- New links default to off (review only on request); existing links are backfilled to on so they keep today's behaviour.
ALTER TABLE "AgentRepository" ADD COLUMN "reviewOnOpen" BOOLEAN NOT NULL DEFAULT false;
UPDATE "AgentRepository" SET "reviewOnOpen" = true;
