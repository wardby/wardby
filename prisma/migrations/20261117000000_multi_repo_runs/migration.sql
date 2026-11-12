-- Several repositories in one coding run (#537).

ALTER TABLE "AgentRepository" ADD COLUMN "name" TEXT;
ALTER TABLE "AgentRepository" ADD COLUMN "ref" TEXT;
ALTER TABLE "AgentRepository" ADD COLUMN "refFromFile" TEXT;
ALTER TABLE "AgentRepository" ADD COLUMN "inDefaultSet" BOOLEAN NOT NULL DEFAULT false;

-- Non-coding links are named <provider>:<repository>: exactly today's (agent, provider, repository) uniqueness.
UPDATE "AgentRepository" ar SET "name" = ar."provider" || ':' || ar."repository"
FROM "Agent" a WHERE a."id" = ar."agentId" AND a."kind" <> 'coding';

-- Coding links: the short name, lower-cased and made folder-safe ([a-z0-9][a-z0-9._-]), at most 59
-- characters so a suffix fits in 63; "workspace" is reserved; a clash on the agent gets -2, -3, ...
DO $$
DECLARE
  r RECORD;
  candidate TEXT;
  n INT;
BEGIN
  FOR r IN
    SELECT ar."id", ar."agentId",
      COALESCE(NULLIF(left(regexp_replace(regexp_replace(
        lower(regexp_replace(ar."repository", '^.*/', '')), '[^a-z0-9._-]', '-', 'g'), '^[^a-z0-9]+', ''), 59), ''),
        'repo') AS short
    FROM "AgentRepository" ar JOIN "Agent" a ON a."id" = ar."agentId"
    WHERE a."kind" = 'coding'
    ORDER BY ar."agentId", ar."createdAt", ar."id"
  LOOP
    candidate := r.short;
    n := 1;
    WHILE candidate = 'workspace'
      OR EXISTS (SELECT 1 FROM "AgentRepository" o WHERE o."agentId" = r."agentId" AND o."name" = candidate) LOOP
      n := n + 1;
      candidate := r.short || '-' || n;
    END LOOP;
    UPDATE "AgentRepository" SET "name" = candidate WHERE "id" = r."id";
  END LOOP;
END $$;

ALTER TABLE "AgentRepository" ALTER COLUMN "name" SET NOT NULL;
DROP INDEX "AgentRepository_agentId_provider_repository_key";
CREATE UNIQUE INDEX "AgentRepository_agentId_name_key" ON "AgentRepository"("agentId", "name");

CREATE TABLE "CodingRunRepository" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "requestedRef" TEXT,
    "refFromFile" TEXT,
    "resolvedSha" TEXT,
    "viaRepositoryLink" BOOLEAN NOT NULL DEFAULT true,
    "linkId" TEXT,
    "baseRef" TEXT,
    "headRef" TEXT,
    "baseSha" TEXT,
    "resultBranch" TEXT,
    "result" JSONB,
    "pullRequestNumber" INTEGER,
    "mergeOrder" INTEGER,
    "markedReadyAt" TIMESTAMP(3),
    "prDescriptionSha256" TEXT,
    "prDescriptionRunId" TEXT,
    "prDescriptionOutcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CodingRunRepository_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CodingRunRepository_runId_name_key" ON "CodingRunRepository"("runId", "name");
CREATE INDEX "CodingRunRepository_provider_repository_pullRequestNumber_idx" ON "CodingRunRepository"("provider", "repository", "pullRequestNumber");
CREATE INDEX "CodingRunRepository_mergeOrder_idx" ON "CodingRunRepository"("mergeOrder");
ALTER TABLE "CodingRunRepository" ADD CONSTRAINT "CodingRunRepository_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CodingRun"("runId") ON DELETE CASCADE ON UPDATE CASCADE;
