-- Additive: what a native sandbox run's review tools have read (repo_pr_read pages and
-- repo_read_file reads), saved between gateway requests so repo_publish_review can refuse
-- unread_files. Null until the run reads a pull request.

-- AlterTable
ALTER TABLE "NativeGatewaySession" ADD COLUMN "reviewReads" JSONB;
