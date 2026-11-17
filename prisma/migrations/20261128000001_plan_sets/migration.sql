-- Agent plan documents (parts B and C).
ALTER TYPE "RunTrigger" ADD VALUE 'plan_approved';

ALTER TABLE "CodingAgentProfile" ADD COLUMN "planDocument" JSONB;
ALTER TABLE "CodingAgentProfile" ADD COLUMN "buildFromPlan" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "CodingRun" ADD COLUMN "planNumber" INTEGER;
ALTER TABLE "CodingRun" ADD COLUMN "planSetId" TEXT;
ALTER TABLE "CodingRun" ADD COLUMN "planVersions" JSONB;
ALTER TABLE "CodingRun" ADD COLUMN "planTicket" INTEGER;
ALTER TABLE "CodingRun" ADD COLUMN "planRepositoryPath" TEXT;

CREATE TABLE "PlanSet" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "store" TEXT NOT NULL,
    "accessAgentId" TEXT,
    "createdByRunId" TEXT NOT NULL,
    "issueProvider" TEXT,
    "issueKey" TEXT,
    "approvedAt" TIMESTAMP(3),
    "chainTicket" INTEGER,
    "chainStopped" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanSet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlanSet_agentId_repository_number_key" ON "PlanSet"("agentId", "repository", "number");
CREATE INDEX "PlanSet_accessAgentId_idx" ON "PlanSet"("accessAgentId");
ALTER TABLE "PlanSet" ADD CONSTRAINT "PlanSet_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlanSet" ADD CONSTRAINT "PlanSet_accessAgentId_fkey" FOREIGN KEY ("accessAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Document" ADD COLUMN "planSetId" TEXT;
ALTER TABLE "Document" ADD COLUMN "planPath" TEXT;
ALTER TABLE "Document" ADD COLUMN "removedFromPlan" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Document_planSetId_idx" ON "Document"("planSetId");
ALTER TABLE "Document" ADD CONSTRAINT "Document_planSetId_fkey" FOREIGN KEY ("planSetId") REFERENCES "PlanSet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
