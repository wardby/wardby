-- Substrate job launcher: the actor templates wardby created, for readiness and cleanup.
CREATE TABLE "SubstrateTemplate" (
    "name" TEXT NOT NULL,
    "atespace" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL,
    "goldenFailures" INTEGER NOT NULL DEFAULT 0,
    "lastFailureAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "SubstrateTemplate_pkey" PRIMARY KEY ("name")
);

CREATE INDEX "SubstrateTemplate_lastUsedAt_idx" ON "SubstrateTemplate"("lastUsedAt");
