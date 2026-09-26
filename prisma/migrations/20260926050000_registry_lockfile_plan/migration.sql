-- Additive: npm lockfile verification (POST /registry/npm/-/plan). See
-- docs/coding-packages.md. Immutable per-version facts read from the
-- registry, and the exact versions a run's lockfile plan approved.

-- CreateTable
CREATE TABLE "RegistryVersionFact" (
    "ecosystem" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "integrity" TEXT NOT NULL,
    "downloadUrl" TEXT NOT NULL,
    "dependencies" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistryVersionFact_pkey" PRIMARY KEY ("ecosystem","name","version")
);

-- CreateTable
CREATE TABLE "RegistryApprovedVersion" (
    "runId" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "integrity" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistryApprovedVersion_pkey" PRIMARY KEY ("runId","ecosystem","name","version")
);

-- AddForeignKey
ALTER TABLE "RegistryApprovedVersion" ADD CONSTRAINT "RegistryApprovedVersion_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CodingRun"("runId") ON DELETE CASCADE ON UPDATE CASCADE;
