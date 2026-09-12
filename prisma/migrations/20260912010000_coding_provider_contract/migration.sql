-- Provider identifiers are externally visible protocol values. Keep their
-- exact spelling (including "claude-code") while application schemas retain
-- the closed allow-list.
BEGIN;

ALTER TABLE "CodingAgentProfile"
  ALTER COLUMN "provider" DROP DEFAULT,
  ALTER COLUMN "provider" TYPE TEXT USING "provider"::TEXT,
  ALTER COLUMN "provider" SET DEFAULT 'codex';

ALTER TABLE "CodingRun"
  ALTER COLUMN "provider" TYPE TEXT USING "provider"::TEXT;

DROP TYPE "CodingProvider";

ALTER TABLE "CodingAgentProfile"
  ADD CONSTRAINT "CodingAgentProfile_provider_check"
  CHECK ("provider" IN ('codex', 'claude-code'));

ALTER TABLE "CodingRun"
  ADD CONSTRAINT "CodingRun_provider_check"
  CHECK ("provider" IN ('codex', 'claude-code'));

COMMIT;
