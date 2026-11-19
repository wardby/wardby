-- Teams: named sets of equal members that own resources, receive grants and carry
-- roles. A team owns and is granted through its backing principal (subject
-- "team:<id>"), so existing owner and grant rules apply unchanged. Additive only.
--
-- Every user also has a Personal team (personal = true) whose backing principal is
-- the user's own principal, so no ownerId changes and access is unchanged on
-- upgrade: the backfill below adds one Team row and one membership per existing
-- user principal (team backing principals, subject "team:<id>", are skipped).
-- Deleting a principal deletes its Personal team.

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "personal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "teamId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("teamId","principalId")
);

-- CreateTable
CREATE TABLE "TeamAudit" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "teamId" TEXT,
    "detail" JSONB,

    CONSTRAINT "TeamAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Team_name_key" ON "Team"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Team_principalId_key" ON "Team"("principalId");

-- CreateIndex
CREATE INDEX "TeamMember_principalId_idx" ON "TeamMember"("principalId");

-- CreateIndex
CREATE INDEX "TeamAudit_teamId_at_idx" ON "TeamAudit"("teamId", "at");

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "Principal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "Principal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: a Personal team for every existing user principal.
INSERT INTO "Team" ("id", "name", "principalId", "roles", "personal", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'personal:' || p."id", p."id", ARRAY[]::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Principal" p
WHERE p."subject" NOT LIKE 'team:%'
  AND NOT EXISTS (SELECT 1 FROM "Team" t WHERE t."principalId" = p."id");

INSERT INTO "TeamMember" ("teamId", "principalId", "createdAt")
SELECT t."id", t."principalId", CURRENT_TIMESTAMP
FROM "Team" t
WHERE t."personal";
