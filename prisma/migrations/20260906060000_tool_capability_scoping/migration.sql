-- Per-attachment capability scoping (OWASP LLM08 fix). Additive: three new
-- JSONB columns on AgentTool, defaulting to an empty array (deny-all) for
-- any row inserted from now on. Pre-existing rows are explicitly backfilled
-- below to their current unrestricted behavior so no already-scheduled
-- agent breaks on deploy -- new attach_tool/CLI calls default to deny-all.
BEGIN;

ALTER TABLE "AgentTool" ADD COLUMN "allowedSecrets" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "AgentTool" ADD COLUMN "allowedDatastorePrefixes" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "AgentTool" ADD COLUMN "allowedHosts" JSONB NOT NULL DEFAULT '[]';

UPDATE "AgentTool" AS at
SET "allowedSecrets" = COALESCE((
      SELECT jsonb_agg(s."name")
      FROM "AgentSecret" ags
      JOIN "Secret" s ON s."id" = ags."secretId"
      WHERE ags."agentId" = at."agentId"
    ), '[]'::jsonb),
    "allowedDatastorePrefixes" = '[""]'::jsonb,
    "allowedHosts" = '["*"]'::jsonb;

COMMIT;
