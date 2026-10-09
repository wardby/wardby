-- Additive: when a native sandbox worker's network isolation was proven. The
-- gateway serves a session only once this is set.

-- AlterTable
ALTER TABLE "NativeGatewaySession" ADD COLUMN "networkReadyAt" TIMESTAMP(3);
