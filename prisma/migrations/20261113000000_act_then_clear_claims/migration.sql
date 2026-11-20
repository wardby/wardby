-- Act-then-clear claims for the leader's deferred work. Additive: nullable timestamps and a
-- counter defaulting to zero, so existing rows mean "never claimed" and "never restarted".
ALTER TABLE "Run" ADD COLUMN "startClaimedAt" TIMESTAMP(3);
ALTER TABLE "Run" ADD COLUMN "startAttempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "DeferredReview" ADD COLUMN "claimedAt" TIMESTAMP(3);
