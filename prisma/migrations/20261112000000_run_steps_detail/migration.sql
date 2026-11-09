-- Run steps detail level: the owner's per-agent setting, the level fixed on each run at
-- dispatch, and the proxy session's copy of it. Additive, nullable: existing rows mean "unset".
CREATE TYPE "RunStepsLevel" AS ENUM ('off', 'summary', 'detail');

ALTER TABLE "Agent" ADD COLUMN "runSteps" "RunStepsLevel";

ALTER TABLE "Run" ADD COLUMN "runStepsLevel" "RunStepsLevel";

ALTER TABLE "CodingProxySession" ADD COLUMN "runStepsLevel" "RunStepsLevel";
