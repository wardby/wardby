-- Native sandbox on Substrate: the startup canary's verdict, recorded by the gateway.
CREATE TABLE "NativeSubstrateCanary" (
    "actor" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reportedAt" TIMESTAMP(3),

    CONSTRAINT "NativeSubstrateCanary_pkey" PRIMARY KEY ("actor")
);

CREATE INDEX "NativeSubstrateCanary_createdAt_idx" ON "NativeSubstrateCanary"("createdAt");
