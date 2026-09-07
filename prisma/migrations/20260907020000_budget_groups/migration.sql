-- Optional recurring (daily/weekly/monthly) spend caps across a group of
-- agents, layered on top of each agent's existing per-run budgetUsd.
-- Additive only: a new table plus one new nullable column on Agent.
CREATE TABLE "BudgetGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT,
    "dailyBudgetUsd" DECIMAL(10,4),
    "weeklyBudgetUsd" DECIMAL(10,4),
    "monthlyBudgetUsd" DECIMAL(10,4),
    "warnThresholdRatio" DECIMAL(3,2) NOT NULL DEFAULT 0.8,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BudgetGroup_ownerId_name_key" ON "BudgetGroup"("ownerId", "name");

ALTER TABLE "BudgetGroup" ADD CONSTRAINT "BudgetGroup_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Principal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Agent" ADD COLUMN "budgetGroupId" TEXT;

ALTER TABLE "Agent" ADD CONSTRAINT "Agent_budgetGroupId_fkey" FOREIGN KEY ("budgetGroupId") REFERENCES "BudgetGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
