-- Additive: repository links for native agents, the check a run owns, and
-- host webhook delivery de-duplication. See
-- docs/private/2026-09-25-code-review-host-design.md §4.

-- CreateTable
CREATE TABLE "AgentRepository" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "triggers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "checkName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRepository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunHostCheck" (
    "runId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RunHostCheck_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "HostEventDelivery" (
    "provider" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HostEventDelivery_pkey" PRIMARY KEY ("provider","deliveryId")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentRepository_agentId_provider_repository_key" ON "AgentRepository"("agentId", "provider", "repository");

-- CreateIndex
CREATE INDEX "AgentRepository_provider_repository_idx" ON "AgentRepository"("provider", "repository");

-- CreateIndex
CREATE INDEX "HostEventDelivery_receivedAt_idx" ON "HostEventDelivery"("receivedAt");

-- AddForeignKey
ALTER TABLE "AgentRepository" ADD CONSTRAINT "AgentRepository_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunHostCheck" ADD CONSTRAINT "RunHostCheck_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
