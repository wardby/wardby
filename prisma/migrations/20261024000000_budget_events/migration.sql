-- Budget refusal records and estimated settlement of interrupted requests.

CREATE TYPE "RunBudgetEventKind" AS ENUM ('refused');

CREATE TABLE "RunBudgetEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" "RunBudgetEventKind" NOT NULL,
    "limit" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB NOT NULL,
    CONSTRAINT "RunBudgetEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RunBudgetEvent_runId_at_idx" ON "RunBudgetEvent"("runId", "at");

ALTER TABLE "RunBudgetEvent" ADD CONSTRAINT "RunBudgetEvent_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CodingRun" ADD COLUMN "budgetLimitedBy" TEXT;

ALTER TABLE "CodingProxyRequest" ADD COLUMN "costEstimated" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "NativeGatewayCall" ADD COLUMN "costEstimated" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "CodingProxySession" ADD COLUMN "budgetRefusal" JSONB;
