-- Additive: per-agent workspace paths never collected from a coding run. See
-- docs/superpowers/specs/2026-09-25-coding-package-registry-design.md §4.

-- AlterTable
ALTER TABLE "CodingAgentProfile" ADD COLUMN     "collectExclude" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "CodingRun" ADD COLUMN     "collectExclude" JSONB NOT NULL DEFAULT '[]';
