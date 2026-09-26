-- Tool names become unique per owner instead of globally, matching
-- BudgetGroup / Datastore / Secret. Safe on existing data: global uniqueness
-- already implies per-owner uniqueness. As with those models, PostgreSQL
-- treats NULLs as distinct, so public (null-owner) tools are not deduplicated
-- by this index; `wardby tool create` checks that case in the application.

-- DropIndex
DROP INDEX "Tool_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "Tool_ownerId_name_key" ON "Tool"("ownerId", "name");
