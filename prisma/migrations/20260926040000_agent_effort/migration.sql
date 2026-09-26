-- Additive: per-agent reasoning effort for native agents. Nullable, so every
-- existing agent keeps the provider's default. Levels are validated in code
-- against the agent's model (low, medium, high, xhigh, max), not a DB enum.

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "effort" TEXT;
