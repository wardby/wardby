-- Un-phased: agent-controlled persistent memory. `memoryEnabled` gates the
-- memory_get/memory_set/memory_list/memory_search built-in tools; AgentMemory
-- holds the key/content rows. No FK to "Agent" (matches "DatastoreEntry").
-- "contentTsv" is a plain column, populated by application code on every
-- write (never a Postgres GENERATED column — see schema.prisma).
ALTER TABLE "Agent" ADD COLUMN "memoryEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "AgentMemory" (
  "agentId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "contentTsv" tsvector,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("agentId", "key")
);

CREATE INDEX "AgentMemory_contentTsv_idx" ON "AgentMemory" USING GIN ("contentTsv");
