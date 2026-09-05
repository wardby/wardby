-- Hand-written per CLEANROOM.md (never `db push`, never generated from
-- another project's migrations). Additive: Phase 2 scheduler + durability.
-- Mirrors prisma/schema.prisma exactly.

-- AlterEnum
-- Postgres 12+ allows ADD VALUE inside a transaction as long as the new
-- value isn't *used* in the same transaction — this migration only adds it.
ALTER TYPE "RunStatus" ADD VALUE 'lost';

-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('manual', 'scheduled');

-- AlterTable: Agent scheduling fields
ALTER TABLE "Agent" ADD COLUMN "schedule" TEXT;
ALTER TABLE "Agent" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE "Agent" ADD COLUMN "scheduleEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Agent" ADD COLUMN "lastScheduledAt" TIMESTAMP(3);

-- AlterTable: Run durability + provenance fields
ALTER TABLE "Run" ADD COLUMN "trigger" "RunTrigger" NOT NULL DEFAULT 'manual';
ALTER TABLE "Run" ADD COLUMN "heartbeatAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SchedulerLease" (
    "scope" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchedulerLease_pkey" PRIMARY KEY ("scope")
);
