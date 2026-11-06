-- Coding runs: pinned MCP tools, the MCP token's hash, and a call counter.
ALTER TABLE "CodingProxySession" ADD COLUMN "mcpTools" JSONB;
ALTER TABLE "CodingProxySession" ADD COLUMN "mcpTokenHash" TEXT;
ALTER TABLE "CodingProxySession" ADD COLUMN "mcpCallCount" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "CodingProxySession_mcpTokenHash_key" ON "CodingProxySession"("mcpTokenHash");
