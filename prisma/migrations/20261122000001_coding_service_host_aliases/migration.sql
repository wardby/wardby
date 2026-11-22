-- Toolchain host aliases (#599): host names a team's code hard-codes for its services, resolved to
-- 127.0.0.1 in the run. Null for every sidecar and for a toolchain without any.
ALTER TABLE "CodingService" ADD COLUMN "hostAliases" JSONB;
