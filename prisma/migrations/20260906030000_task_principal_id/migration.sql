-- Add nullable Task.principalId: replaces transitive
-- Task -> Run -> Agent -> ownerId ownership resolution with a direct
-- stamp-at-creation column, uniform across task kinds (including future
-- tool_authoring tasks, which have no Run/Agent chain).
ALTER TABLE "Task" ADD COLUMN "principalId" TEXT;
