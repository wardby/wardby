-- Additive: coding package registry. See
-- docs/superpowers/specs/2026-09-25-coding-package-registry-design.md.

-- CreateEnum
CREATE TYPE "RegistryFetchOutcome" AS ENUM ('served', 'refused');

-- AlterTable
ALTER TABLE "CodingAgentProfile" ADD COLUMN     "packageAllowlist" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "packagePolicy" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "CodingRun" ADD COLUMN     "packageAllowlist" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "packagePolicy" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "CodingProxySession" ADD COLUMN     "registryTokenHash" TEXT;

-- CreateTable
CREATE TABLE "RegistryAllowance" (
    "runId" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistryAllowance_pkey" PRIMARY KEY ("runId","ecosystem","name")
);

-- CreateTable
CREATE TABLE "RegistryFetch" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT,
    "filename" TEXT,
    "integrity" TEXT,
    "sizeBytes" INTEGER,
    "outcome" "RegistryFetchOutcome" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistryFetch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CodingProxySession_registryTokenHash_key" ON "CodingProxySession"("registryTokenHash");

-- CreateIndex
CREATE INDEX "RegistryFetch_runId_createdAt_idx" ON "RegistryFetch"("runId", "createdAt");

-- AddForeignKey
ALTER TABLE "RegistryAllowance" ADD CONSTRAINT "RegistryAllowance_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CodingRun"("runId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryFetch" ADD CONSTRAINT "RegistryFetch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CodingRun"("runId") ON DELETE CASCADE ON UPDATE CASCADE;
