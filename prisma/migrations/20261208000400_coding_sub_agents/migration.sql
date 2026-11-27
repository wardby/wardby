-- Coding agents' sub-agents and web-tool settings (Gemini CLI phase 4): stored on the profile, fixed on
-- each run at dispatch, and copied onto the run's proxy session. Additive; defaults keep every existing
-- run as it was (a run dispatched before this has subAgents false), and give existing agents
-- sub-agents on (the documented upgrade change) with web tools off. The provider CHECK constraints
-- (20260912010000) also learn 'gemini-cli'.
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "CodingAgentProfile" ADD COLUMN "webTools" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "CodingAgentProfile" ADD COLUMN "subAgents" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "CodingRun" ADD COLUMN "webTools" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "CodingRun" ADD COLUMN "subAgents" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "CodingProxySession" ADD COLUMN "subAgents" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "CodingAgentProfile" DROP CONSTRAINT "CodingAgentProfile_provider_check";
ALTER TABLE "CodingAgentProfile"
  ADD CONSTRAINT "CodingAgentProfile_provider_check"
  CHECK ("provider" IN ('codex', 'claude-code', 'gemini-cli'));

ALTER TABLE "CodingRun" DROP CONSTRAINT "CodingRun_provider_check";
ALTER TABLE "CodingRun"
  ADD CONSTRAINT "CodingRun_provider_check"
  CHECK ("provider" IN ('codex', 'claude-code', 'gemini-cli'));

COMMIT;
