-- Run hooks: a sandbox tool wardby calls when one of an agent's workflow
-- events happens, and one delivery row per hook per event. Additive.
CREATE TABLE "RunHook" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "statuses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "runs" TEXT NOT NULL DEFAULT 'top_level',
    "includeFinalText" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "allowedSecrets" JSONB NOT NULL DEFAULT '[]',
    "allowedHosts" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "capabilitiesGrantedById" TEXT,
    "finalTextApprovedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunHook_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RunHookDelivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "hookId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunHookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RunHook_agentId_idx" ON "RunHook"("agentId");
CREATE INDEX "RunHook_toolId_idx" ON "RunHook"("toolId");
CREATE UNIQUE INDEX "RunHookDelivery_eventId_hookId_key" ON "RunHookDelivery"("eventId", "hookId");
CREATE INDEX "RunHookDelivery_state_nextAttemptAt_idx" ON "RunHookDelivery"("state", "nextAttemptAt");
CREATE INDEX "RunHookDelivery_hookId_idx" ON "RunHookDelivery"("hookId");

ALTER TABLE "RunHook" ADD CONSTRAINT "RunHook_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RunHook" ADD CONSTRAINT "RunHook_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RunHookDelivery" ADD CONSTRAINT "RunHookDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "WorkflowEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RunHookDelivery" ADD CONSTRAINT "RunHookDelivery_hookId_fkey" FOREIGN KEY ("hookId") REFERENCES "RunHook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
