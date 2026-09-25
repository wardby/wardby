-- allowedEgress was stored but never enforced and is no longer written. A default
-- lets new rows omit it; the columns are dropped in a later release.

-- AlterTable
ALTER TABLE "CodingAgentProfile" ALTER COLUMN "allowedEgress" SET DEFAULT '[]';

-- AlterTable
ALTER TABLE "CodingRun" ALTER COLUMN "allowedEgress" SET DEFAULT '[]';
