-- Add nullable so existing rows survive the ADD.
ALTER TABLE "AgentSecret" ADD COLUMN "boundName" TEXT;

-- Backfill: existing attachments resolve by the secret's canonical name,
-- so their point-of-use name IS that name.
UPDATE "AgentSecret" a
SET "boundName" = s."name"
FROM "Secret" s
WHERE a."secretId" = s."id";

-- Lock it down.
ALTER TABLE "AgentSecret" ALTER COLUMN "boundName" SET NOT NULL;

-- One point-of-use name per agent.
CREATE UNIQUE INDEX "AgentSecret_agentId_boundName_key"
  ON "AgentSecret" ("agentId", "boundName");
