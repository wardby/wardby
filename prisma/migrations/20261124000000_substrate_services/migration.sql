-- Coding services on the Substrate job launcher.
-- The argv that starts a service (its image's ENTRYPOINT + CMD); only the Substrate launcher uses it.
ALTER TABLE "CodingService" ADD COLUMN "startCommand" JSONB;

-- The built-in entries' start commands, as their pinned images define them.
UPDATE "CodingService" SET "startCommand" = '["docker-entrypoint.sh","postgres"]'::jsonb
  WHERE "builtin" = true AND "name" = 'postgres';
UPDATE "CodingService" SET "startCommand" = '["docker-entrypoint.sh","redis-server"]'::jsonb
  WHERE "builtin" = true AND "name" = 'redis';
UPDATE "CodingService" SET "startCommand" = '["docker-entrypoint.sh","mysqld"]'::jsonb
  WHERE "builtin" = true AND "name" = 'mysql';

-- A Substrate run's coding services, by catalog name (sorted), set at claim; null for a run without any.
ALTER TABLE "SubstrateRun" ADD COLUMN "services" JSONB;
