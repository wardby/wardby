-- Plan documents (PR: agent plan documents, part A): the coding run's plan-files channel.
ALTER TABLE "CodingRun" ADD COLUMN "collectPlanFiles" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CodingRun" ADD COLUMN "planFilesStatus" TEXT;
ALTER TABLE "CodingRun" ADD COLUMN "planFilesWithheld" JSONB;
ALTER TABLE "CodingRun" ADD COLUMN "planFilesSkipped" JSONB;

CREATE TABLE "CodingRunPlanFile" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodingRunPlanFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CodingRunPlanFile_runId_direction_path_key" ON "CodingRunPlanFile"("runId", "direction", "path");
CREATE INDEX "CodingRunPlanFile_runId_idx" ON "CodingRunPlanFile"("runId");

ALTER TABLE "CodingRunPlanFile" ADD CONSTRAINT "CodingRunPlanFile_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CodingRun"("runId") ON DELETE CASCADE ON UPDATE CASCADE;
