-- Additive: per-agent coding workspace size. See
-- docs/superpowers/specs/2026-09-22-phase-12-kubernetes-job-launcher-design.md §4.

-- AlterTable
ALTER TABLE "CodingAgentProfile" ADD COLUMN     "workspaceDiskMb" INTEGER;

-- AlterTable
ALTER TABLE "CodingRun" ADD COLUMN     "workspaceDiskMb" INTEGER;
