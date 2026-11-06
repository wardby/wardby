-- Remote MCP servers an owner registers, and their attachments to native agents.
CREATE TABLE "McpServer" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "toolSnapshot" JSONB NOT NULL DEFAULT '[]',
    "snapshotAt" TIMESTAMP(3),
    "serverInfo" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "McpServer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentMcpServer" (
    "agentId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "allowedTools" TEXT[],
    "callTimeoutMs" INTEGER,
    "attachedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentMcpServer_pkey" PRIMARY KEY ("agentId", "serverId")
);

CREATE UNIQUE INDEX "McpServer_ownerId_name_key" ON "McpServer"("ownerId", "name");
CREATE INDEX "McpServer_ownerId_idx" ON "McpServer"("ownerId");
CREATE INDEX "AgentMcpServer_serverId_idx" ON "AgentMcpServer"("serverId");

ALTER TABLE "McpServer" ADD CONSTRAINT "McpServer_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Principal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentMcpServer" ADD CONSTRAINT "AgentMcpServer_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentMcpServer" ADD CONSTRAINT "AgentMcpServer_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
