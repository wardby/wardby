-- Resource sharing grants (A2/S2-2, N1, R2-1, A6). Replaces "null owner =
-- public and mutable by anyone" with explicit grants. See
-- docs/private/2026-09-26-resource-sharing-grants-spec-and-plan.md.
-- Needs PostgreSQL 13+ for gen_random_uuid() (core since 13).

-- CreateTable
CREATE TABLE "ResourceGrant" (
    "id" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "granteeKind" TEXT NOT NULL,
    "granteePrincipalId" TEXT,
    "granteeKey" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'owner',
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResourceGrant_resourceType_resourceId_granteeKey_key" ON "ResourceGrant"("resourceType", "resourceId", "granteeKey");

-- CreateIndex
CREATE INDEX "ResourceGrant_granteeKey_resourceType_idx" ON "ResourceGrant"("granteeKey", "resourceType");

-- CreateIndex
CREATE INDEX "ResourceGrant_granteePrincipalId_idx" ON "ResourceGrant"("granteePrincipalId");

-- AddForeignKey
ALTER TABLE "ResourceGrant" ADD CONSTRAINT "ResourceGrant_granteePrincipalId_fkey" FOREIGN KEY ("granteePrincipalId") REFERENCES "Principal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grantee shape. Not representable in schema.prisma (like DatastoreEntry_scope_xor,
-- 20260912040000_named_shared_datastores), so invisible to migrate diff.
ALTER TABLE "ResourceGrant" ADD CONSTRAINT "ResourceGrant_grantee_shape" CHECK (
    ("granteeKind" = 'principal' AND "granteePrincipalId" IS NOT NULL
        AND "granteeKey" = 'principal:' || "granteePrincipalId")
    OR ("granteeKind" = 'everyone' AND "granteePrincipalId" IS NULL AND "granteeKey" = 'everyone')
);

-- AlterTable
ALTER TABLE "Run" ADD COLUMN "triggeredById" TEXT;

-- CreateIndex
CREATE INDEX "Run_agentId_triggeredById_idx" ON "Run"("agentId", "triggeredById");

-- AlterTable
ALTER TABLE "AgentTool" ADD COLUMN "attachedById" TEXT,
    ADD COLUMN "capabilitiesGrantedById" TEXT;

-- Data: owner-less agents keep working at execute-for-everyone; nobody can edit them.
INSERT INTO "ResourceGrant" ("id", "resourceType", "resourceId", "granteeKind", "granteeKey", "level", "source", "updatedAt")
SELECT gen_random_uuid()::text, 'agent', a."id", 'everyone', 'everyone', 'execute', 'migration_public', CURRENT_TIMESTAMP
FROM "Agent" a WHERE a."ownerId" IS NULL;

-- Data: capabilities on an owned agent whose tool is the owner's or owner-less
-- were set by that owner (only the owner could attach to an owned agent, and
-- only its own or an owner-less tool), so they carry its consent. Every other
-- attachment stays unstamped = inert until the owner re-grants.
UPDATE "AgentTool" at
SET "capabilitiesGrantedById" = a."ownerId", "attachedById" = a."ownerId"
FROM "Agent" a, "Tool" t
WHERE a."id" = at."agentId" AND t."id" = at."toolId"
  AND a."ownerId" IS NOT NULL
  AND (t."ownerId" IS NULL OR t."ownerId" = a."ownerId");

-- Data: triggerer of historic runs, where a Task recorded it.
UPDATE "Run" r SET "triggeredById" = t."principalId"
FROM "Task" t
WHERE t."runId" = r."id" AND t."kind" = 'run' AND t."principalId" IS NOT NULL;
