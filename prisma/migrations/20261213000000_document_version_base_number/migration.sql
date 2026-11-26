-- The version each version was based on: the writer's expectedNumber (live editing merges from it).
ALTER TABLE "DocumentVersion" ADD COLUMN "baseNumber" INTEGER;
