-- Package audit mode (docs/coding-packages.md#package-audit-mode): a timed
-- per-agent mode, fixed on each coding run at dispatch, and the run's record
-- of what the registry served only because of it.
CREATE TYPE "PackageAuditMode" AS ENUM ('audit', 'full');

ALTER TABLE "CodingAgentProfile" ADD COLUMN "packageAuditMode" "PackageAuditMode";
ALTER TABLE "CodingAgentProfile" ADD COLUMN "packageAuditUntil" TIMESTAMP(3);
ALTER TABLE "CodingRun" ADD COLUMN "packageAuditMode" "PackageAuditMode";
ALTER TABLE "RegistryAllowance" ADD COLUMN "auditedVia" TEXT;
ALTER TABLE "RegistryApprovedVersion" ADD COLUMN "audit" JSONB;

CREATE TABLE "RegistryAuditRecord" (
    "runId" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "via" TEXT,
    "sizeBytes" INTEGER,
    "advisories" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistryAuditRecord_pkey" PRIMARY KEY ("runId","ecosystem","name","version")
);

ALTER TABLE "RegistryAuditRecord" ADD CONSTRAINT "RegistryAuditRecord_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "CodingRun"("runId") ON DELETE CASCADE ON UPDATE CASCADE;
