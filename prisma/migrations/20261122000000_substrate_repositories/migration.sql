-- Substrate multi-repository runs: a run's extra repositories ([{ name, access }], never a host path).
ALTER TABLE "SubstrateRun" ADD COLUMN "repositories" JSONB;
