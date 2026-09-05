-- Hand-written per CLEANROOM.md (never `db push`, never generated from
-- another project's migrations). Additive: Phase 3 tools + multi-turn loop.
-- Mirrors prisma/schema.prisma exactly.

-- AlterEnum
-- Postgres 12+ allows ADD VALUE inside a transaction as long as the new
-- value isn't *used* in the same transaction — this migration only adds it.
ALTER TYPE "RunStatus" ADD VALUE 'budget_exhausted';

-- AlterTable: Agent gains maxTurns
ALTER TABLE "Agent" ADD COLUMN "maxTurns" INTEGER NOT NULL DEFAULT 10;

-- CreateTable
CREATE TABLE "Tool" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "paramsZod" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tool_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Tool_name_key" ON "Tool"("name");

-- CreateTable
CREATE TABLE "AgentTool" (
    "agentId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,

    CONSTRAINT "AgentTool_pkey" PRIMARY KEY ("agentId","toolId")
);

ALTER TABLE "AgentTool" ADD CONSTRAINT "AgentTool_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentTool" ADD CONSTRAINT "AgentTool_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "DatastoreEntry" (
    "agentId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DatastoreEntry_pkey" PRIMARY KEY ("agentId","key")
);
