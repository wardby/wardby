-- Review router (#646): router settings, routed documents, shared document sets, review jobs, run document grants.
ALTER TYPE "RunTrigger" ADD VALUE IF NOT EXISTS 'review_action';

ALTER TABLE "Agent"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "router" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reviewRouterId" TEXT,
  ADD COLUMN "maxStartsPerDecision" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_reviewRouterId_fkey"
  FOREIGN KEY ("reviewRouterId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Agent_reviewRouterId_idx" ON "Agent"("reviewRouterId");

CREATE TABLE "DocumentSet" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "name" TEXT,
  "routerAgentId" TEXT,
  "createdByRunId" TEXT,
  "approvedAt" TIMESTAMP(3),
  "approvedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DocumentSet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DocumentSet_createdByRunId_name_key" ON "DocumentSet"("createdByRunId", "name");
CREATE INDEX "DocumentSet_agentId_idx" ON "DocumentSet"("agentId");
CREATE INDEX "DocumentSet_routerAgentId_idx" ON "DocumentSet"("routerAgentId");
ALTER TABLE "DocumentSet" ADD CONSTRAINT "DocumentSet_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentSet" ADD CONSTRAINT "DocumentSet_routerAgentId_fkey"
  FOREIGN KEY ("routerAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Document"
  ADD COLUMN "routerAgentId" TEXT,
  ADD COLUMN "setId" TEXT,
  ADD COLUMN "option" TEXT;
CREATE INDEX "Document_routerAgentId_idx" ON "Document"("routerAgentId");
CREATE INDEX "Document_setId_idx" ON "Document"("setId");
ALTER TABLE "Document" ADD CONSTRAINT "Document_routerAgentId_fkey"
  FOREIGN KEY ("routerAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_setId_fkey"
  FOREIGN KEY ("setId") REFERENCES "DocumentSet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PlanSet" ADD COLUMN "setId" TEXT;
CREATE UNIQUE INDEX "PlanSet_setId_key" ON "PlanSet"("setId");
ALTER TABLE "PlanSet" ADD CONSTRAINT "PlanSet_setId_fkey"
  FOREIGN KEY ("setId") REFERENCES "DocumentSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ReviewJob" (
  "id" TEXT NOT NULL,
  "reviewEventId" TEXT NOT NULL,
  "documentId" TEXT,
  "setId" TEXT,
  "routerAgentId" TEXT NOT NULL,
  "routerRunId" TEXT,
  "rootJobId" TEXT,
  "startsUsed" INTEGER NOT NULL DEFAULT 0,
  "startedById" TEXT,
  "outcome" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReviewJob_reviewEventId_key" ON "ReviewJob"("reviewEventId");
CREATE INDEX "ReviewJob_routerRunId_idx" ON "ReviewJob"("routerRunId");
CREATE INDEX "ReviewJob_rootJobId_idx" ON "ReviewJob"("rootJobId");
CREATE INDEX "ReviewJob_documentId_createdAt_idx" ON "ReviewJob"("documentId", "createdAt");
CREATE INDEX "ReviewJob_setId_createdAt_idx" ON "ReviewJob"("setId", "createdAt");
ALTER TABLE "ReviewJob" ADD CONSTRAINT "ReviewJob_routerAgentId_fkey"
  FOREIGN KEY ("routerAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RunDocumentGrant" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RunDocumentGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RunDocumentGrant_runId_documentId_key" ON "RunDocumentGrant"("runId", "documentId");
CREATE INDEX "RunDocumentGrant_documentId_idx" ON "RunDocumentGrant"("documentId");

-- Backfill: one shared set per plan set, carrying its approval; its documents join it (spec §6).
INSERT INTO "DocumentSet" ("id", "agentId", "ownerId", "routerAgentId", "createdByRunId", "approvedAt", "approvedById", "createdAt", "updatedAt")
SELECT 'ds_' || ps."id", ps."agentId", COALESCE(a."ownerId", ''), NULL, ps."createdByRunId", ps."approvedAt", ps."approvedById", ps."createdAt", ps."updatedAt"
FROM "PlanSet" ps JOIN "Agent" a ON a."id" = ps."agentId";
UPDATE "PlanSet" SET "setId" = 'ds_' || "id";
UPDATE "Document" SET "setId" = 'ds_' || "planSetId", "option" = "planPath" WHERE "planSetId" IS NOT NULL;
