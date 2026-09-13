-- Additive: agent-composition edges (AgentSubAgent), run-tree linkage for
-- sub-agent dispatch (Run.parentRunId/childRuns), and the ephemeral
-- per-dispatch parent-memory grant (Run.grantedParentMemoryKeys). See
-- docs/private/2026-09-13-agent-subagent-design-and-plan.md.

-- AlterEnum
ALTER TYPE "RunTrigger" ADD VALUE 'subagent';

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "grantedParentMemoryKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "parentRunId" TEXT;

-- CreateTable
CREATE TABLE "AgentSubAgent" (
    "parentAgentId" TEXT NOT NULL,
    "childAgentId" TEXT NOT NULL,
    "boundName" TEXT NOT NULL,

    CONSTRAINT "AgentSubAgent_pkey" PRIMARY KEY ("parentAgentId","childAgentId")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentSubAgent_parentAgentId_boundName_key" ON "AgentSubAgent"("parentAgentId", "boundName");

-- AddForeignKey
ALTER TABLE "AgentSubAgent" ADD CONSTRAINT "AgentSubAgent_parentAgentId_fkey" FOREIGN KEY ("parentAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSubAgent" ADD CONSTRAINT "AgentSubAgent_childAgentId_fkey" FOREIGN KEY ("childAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
