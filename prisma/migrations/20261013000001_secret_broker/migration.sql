ALTER TABLE "Secret" ADD COLUMN "broker" JSONB;

CREATE TABLE "SecretBrokerChange" (
    "id" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "secretName" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "via" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SecretBrokerChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SecretBrokerChange_secretId_createdAt_idx" ON "SecretBrokerChange"("secretId", "createdAt");
CREATE INDEX "SecretBrokerChange_ownerId_createdAt_idx" ON "SecretBrokerChange"("ownerId", "createdAt");
