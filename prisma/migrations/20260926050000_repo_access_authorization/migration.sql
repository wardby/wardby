-- Repository access authorization (security findings H5-1/A3/C3-2, H5-2,
-- E-08/H5-4). A principal can give an agent authority over a repository only
-- through its own verified host identity's access, or an explicit, recorded
-- admin approval; the authorization is stamped on the row that grants it.
-- See docs/private/2026-09-26-repo-access-authorization-spec-and-plan.md §5.

-- CreateTable
CREATE TABLE "HostIdentity" (
    "principalId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "hostUserId" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostIdentity_pkey" PRIMARY KEY ("principalId","provider")
);

-- CreateTable
CREATE TABLE "HostIdentityLinkRequest" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "hostUserId" TEXT,
    "login" TEXT,
    "confirmHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "callbackAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HostIdentityLinkRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HostIdentity_provider_hostUserId_key" ON "HostIdentity"("provider", "hostUserId");

-- CreateIndex
CREATE UNIQUE INDEX "HostIdentityLinkRequest_stateHash_key" ON "HostIdentityLinkRequest"("stateHash");

-- CreateIndex
CREATE INDEX "HostIdentityLinkRequest_principalId_idx" ON "HostIdentityLinkRequest"("principalId");

-- CreateIndex
CREATE INDEX "HostIdentityLinkRequest_expiresAt_idx" ON "HostIdentityLinkRequest"("expiresAt");

-- AddForeignKey
ALTER TABLE "HostIdentity" ADD CONSTRAINT "HostIdentity_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "Principal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostIdentityLinkRequest" ADD CONSTRAINT "HostIdentityLinkRequest_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "Principal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "AgentRepository" ADD COLUMN     "authorizedAt" TIMESTAMP(3),
ADD COLUMN     "authorizedById" TEXT,
ADD COLUMN     "authorizedVia" TEXT;

-- AlterTable
ALTER TABLE "CodingAgentProfile" ADD COLUMN     "repositoryAuthorizedAt" TIMESTAMP(3),
ADD COLUMN     "repositoryAuthorizedById" TEXT,
ADD COLUMN     "repositoryAuthorizedVia" TEXT;

-- AlterTable
ALTER TABLE "RunHostCheck" ADD COLUMN     "prNumber" INTEGER;

-- Backfill: every existing assignment is the operator's own and keeps
-- working ("grandfathered", not re-checked at use). New or changed
-- assignments go through the check.
UPDATE "AgentRepository" SET "authorizedVia" = 'grandfathered', "authorizedAt" = CURRENT_TIMESTAMP;
UPDATE "CodingAgentProfile" SET "repositoryAuthorizedVia" = 'grandfathered', "repositoryAuthorizedAt" = CURRENT_TIMESTAMP;

-- Deliberate: a check name is only meaningful with the pull_request trigger
-- (a check is only ever published for the PR a run was dispatched for), so
-- names on other links are cleared before the name becomes unique per
-- repository. Existing pull_request links were already unique by name.
UPDATE "AgentRepository" SET "checkName" = NULL
  WHERE "triggers" IS NULL OR NOT ('pull_request' = ANY("triggers"));

-- CreateIndex
CREATE UNIQUE INDEX "AgentRepository_provider_repository_checkName_key" ON "AgentRepository"("provider", "repository", "checkName");
