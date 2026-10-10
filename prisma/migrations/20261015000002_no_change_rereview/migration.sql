-- Additive: a review-fix round that made no change re-reviews the requesting review once.
ALTER TABLE "RunHostCheck" ADD COLUMN "noChangeRereviewAt" TIMESTAMP(3);
