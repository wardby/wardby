-- The status row is now written with the run, before its comment exists.

-- AlterTable
ALTER TABLE "RunHostStatus" ALTER COLUMN "commentId" DROP NOT NULL,
ADD COLUMN "replyToReviewCommentId" TEXT;
