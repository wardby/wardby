-- Additive: per-run task text for a native agent's dispatched sub-agent
-- runs. See docs/private/2026-09-13-agent-subagent-design-and-plan.md.

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "taskOverride" TEXT;
