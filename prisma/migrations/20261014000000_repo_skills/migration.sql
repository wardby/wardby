-- Additive: per-agent switch for loading the repository's agent skills into
-- coding runs, the per-agent Claude Code bare-mode switch, and the values fixed
-- on each run at dispatch. Defaults keep existing behavior and hardening.

-- AlterTable
ALTER TABLE "CodingAgentProfile" ADD COLUMN "repoSkills" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "CodingAgentProfile" ADD COLUMN "claudeBareMode" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "CodingRun" ADD COLUMN "repoSkills" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "CodingRun" ADD COLUMN "claudeBareMode" BOOLEAN NOT NULL DEFAULT true;
