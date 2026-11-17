-- Native sandbox on Substrate: the worker's exit code, reported by its supervisor and recorded by the
-- gateway once (Substrate's actor state never shows a process exit). Null on every other launcher.
ALTER TABLE "NativeGatewaySession" ADD COLUMN "workerExitCode" INTEGER;
ALTER TABLE "NativeGatewaySession" ADD COLUMN "workerExitedAt" TIMESTAMP(3);
