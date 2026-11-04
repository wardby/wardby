-- A coding agent may work in several repositories: each link can name its own base
-- branch, and a run records that its repository came from a link.
ALTER TABLE "AgentRepository" ADD COLUMN "baseRef" TEXT;
ALTER TABLE "CodingRun" ADD COLUMN "viaRepositoryLink" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NativeGatewayCall" ADD COLUMN "childRepository" TEXT;
