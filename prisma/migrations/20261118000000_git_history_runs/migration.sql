-- Git history in coding runs (#536): the per-agent setting, its per-run copy, and remote-link rows.
ALTER TABLE "CodingAgentProfile" ADD COLUMN "gitHistoryDepth" INTEGER;
ALTER TABLE "CodingAgentProfile" ADD COLUMN "gitHistoryFull" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CodingRun" ADD COLUMN "gitHistoryDepth" INTEGER;
ALTER TABLE "CodingRun" ADD COLUMN "gitHistoryFull" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AgentRepository" ADD COLUMN "asRemote" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CodingRunRepository" ADD COLUMN "asRemote" BOOLEAN NOT NULL DEFAULT false;
