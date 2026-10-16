-- Least-privilege database access for the GKE deployment, applied by
-- deploy/gke/bootstrap-database-iam.sh as the built-in owner. Idempotent.
--
-- {{owner}}    the built-in user that owns every table (terraform output database_user)
-- {{migrator}} {{app}} {{proxy}} {{gateway}}  the four Cloud SQL IAM users
--
-- Privileges go to NOLOGIN group roles, so nothing below names a project; the
-- IAM users only become members. If the coding proxy's code starts using
-- another table, deploy/gke/database-grants.database.test.mjs fails: extend
-- wardby_proxy here; up.sh applies this file after its migrations. Each statement ends with a
-- "-- ;;" line, which is how the test splits the file.
--
-- The bootstrap runs the whole file in one transaction: a refused statement
-- leaves nothing applied. Order: group roles, then memberships, then
-- privileges. Grants on named tables apply only once those tables exist, so the
-- file also runs on a fresh, unmigrated database (for the migrator's
-- membership); up.sh applies it again after its migrations, which adds the rest.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wardby_app') THEN CREATE ROLE wardby_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wardby_proxy') THEN CREATE ROLE wardby_proxy NOLOGIN; END IF;
END $$;
-- ;;

-- The migrator acts as the owner in every session, so migrations can alter
-- existing tables and new tables are owned by the owner, as before IAM login.
GRANT "{{owner}}" TO "{{migrator}}";
-- ;;
ALTER ROLE "{{migrator}}" SET role = '{{owner}}';
-- ;;
GRANT wardby_app TO "{{app}}";
-- ;;
GRANT wardby_proxy TO "{{proxy}}";
-- ;;
-- The native sandbox gateway settles sandboxed runs, dispatches their delegations and serves
-- their memory, datastores and secrets: the app's data access, under its own login.
GRANT wardby_app TO "{{gateway}}";
-- ;;

-- The app: data, never schema. The default privileges cover every table the
-- migrator creates later, including on a database migrated after this ran.
GRANT USAGE ON SCHEMA public TO wardby_app;
-- ;;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wardby_app;
-- ;;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO wardby_app;
-- ;;
ALTER DEFAULT PRIVILEGES FOR ROLE "{{owner}}" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wardby_app;
-- ;;
ALTER DEFAULT PRIVILEGES FOR ROLE "{{owner}}" IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO wardby_app;
-- ;;

-- The durable executor (EXECUTOR=dbos): DBOS keeps its workflow and step
-- records in schema "dbos". The migrator creates and migrates it (the migration
-- Job's `npm run dbos:migrate`), so its tables are owned by the owner like
-- Prisma's; the app gets the same data-not-schema access it has on public.
-- Without USAGE and SELECT the app cannot see dbos.dbos_migrations, takes the
-- schema for a new one at launch, and fails on CREATE SCHEMA. Created here, not
-- only by the Job, because ALTER DEFAULT PRIVILEGES ... IN SCHEMA needs it to
-- exist; either may run first.
CREATE SCHEMA IF NOT EXISTS dbos AUTHORIZATION "{{owner}}";
-- ;;
GRANT USAGE ON SCHEMA dbos TO wardby_app;
-- ;;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA dbos TO wardby_app;
-- ;;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA dbos TO wardby_app;
-- ;;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA dbos TO wardby_app;
-- ;;
ALTER DEFAULT PRIVILEGES FOR ROLE "{{owner}}" IN SCHEMA dbos
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wardby_app;
-- ;;
ALTER DEFAULT PRIVILEGES FOR ROLE "{{owner}}" IN SCHEMA dbos
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO wardby_app;
-- ;;
ALTER DEFAULT PRIVILEGES FOR ROLE "{{owner}}" IN SCHEMA dbos
  GRANT EXECUTE ON FUNCTIONS TO wardby_app;
-- ;;

-- The coding proxy: its budget ledger (src/providers/coding-proxy/prisma-ledger.ts),
-- its package registry store (src/providers/coding-proxy/registry/prisma-store.ts)
-- and its dependency cache.
GRANT USAGE ON SCHEMA public TO wardby_proxy;
-- ;;

-- Grants on named tables, each only once its table exists (skipped on an
-- unmigrated database; up.sh applies them after its migrations). The app
-- loses the migration history the default privileges gave it: only the
-- migrator, acting as the owner, has any business there.
DO $$ BEGIN
  IF to_regclass('public."CodingProxySession"') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO wardby_proxy', 'CodingProxySession');
  END IF;
  IF to_regclass('public."CodingProxyRequest"') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO wardby_proxy', 'CodingProxyRequest');
  END IF;
  IF to_regclass('public."RunModelUsage"') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO wardby_proxy', 'RunModelUsage');
  END IF;
  IF to_regclass('public."Run"') IS NOT NULL THEN
    EXECUTE format('GRANT UPDATE (%I, %I, %I, %I), SELECT (%I) ON public.%I TO wardby_proxy',
      'tokensIn', 'tokensOut', 'costUsd', 'turns', 'id', 'Run');
  END IF;
  -- The package registry (src/providers/coding-proxy/registry/prisma-store.ts):
  -- it reads a run's package allowlist and policy snapshot, and records the
  -- allowances and fetches of that run. It never updates or deletes either.
  -- The dependency cache derives its keys from the run's repository and
  -- images and checks the run's cache flag; the run's cache result is the
  -- control plane's to write, so the proxy never writes CodingRun. Package
  -- audit mode is fixed on the run at dispatch (packageAuditMode); the proxy
  -- only reads it, and records what it served under it in
  -- RegistryAuditRecord, which it never updates.
  IF to_regclass('public."CodingRun"') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT (%I, %I, %I, %I, %I, %I, %I, %I) ON public.%I TO wardby_proxy',
      'runId', 'packageAllowlist', 'packagePolicy', 'repository', 'workerImage', 'toolImage', 'dependencyCache',
      'packageAuditMode', 'CodingRun');
  END IF;
  IF to_regclass('public."RegistryAllowance"') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO wardby_proxy', 'RegistryAllowance');
  END IF;
  IF to_regclass('public."RegistryFetch"') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO wardby_proxy', 'RegistryFetch');
  END IF;
  IF to_regclass('public."RegistryAuditRecord"') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO wardby_proxy', 'RegistryAuditRecord');
  END IF;
  -- Lockfile verification: immutable per-version facts (reused forever, never
  -- changed) and the exact versions a run's plan approved or refused.
  IF to_regclass('public."RegistryVersionFact"') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO wardby_proxy', 'RegistryVersionFact');
  END IF;
  IF to_regclass('public."RegistryApprovedVersion"') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO wardby_proxy', 'RegistryApprovedVersion');
  END IF;
  IF to_regclass('public."RegistryPlanRefusal"') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO wardby_proxy', 'RegistryPlanRefusal');
  END IF;
  -- The dependency cache's snapshot metadata: the proxy records snapshots,
  -- marks them used, and evicts them. (Its session columns,
  -- dependencyCacheLockHashes and dependencyCacheSealedAt, are covered by the
  -- table-wide CodingProxySession grant above.)
  IF to_regclass('public."DependencySnapshot"') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO wardby_proxy', 'DependencySnapshot');
  END IF;
  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON public.%I FROM wardby_app', '_prisma_migrations');
  END IF;
END $$;
-- ;;
