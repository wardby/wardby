-- CreateTable
CREATE TABLE "AgentPromptVersion" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "createdById" TEXT,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentPromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentPromptVersion_agentId_number_key" ON "AgentPromptVersion"("agentId", "number");

-- AddForeignKey
ALTER TABLE "AgentPromptVersion" ADD CONSTRAINT "AgentPromptVersion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing agent starts at version 1 with its live prompt.
INSERT INTO "AgentPromptVersion" ("id", "agentId", "number", "systemPrompt", "contentHash", "via")
SELECT gen_random_uuid()::text, "id", 1, "systemPrompt",
       encode(sha256(convert_to("systemPrompt", 'UTF8')), 'hex'), 'backfill'
FROM "Agent";
