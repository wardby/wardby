-- Phase 6: durable executor backend marker on Run (additive, nullable).
ALTER TABLE "Run" ADD COLUMN "executionBackend" TEXT;
