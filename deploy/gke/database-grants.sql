-- Least-privilege database access for the GKE deployment, applied by
-- deploy/gke/bootstrap-database-iam.sh as the built-in owner. Idempotent.
--
-- {{owner}}    the built-in user that owns every table (terraform output database_user)
-- {{migrator}} {{app}} {{proxy}}  the three Cloud SQL IAM users
--
-- Privileges go to NOLOGIN group roles, so nothing below names a project; the
-- IAM users only become members. If the coding proxy's code starts using
-- another table, deploy/gke/database-grants.database.test.mjs fails: extend
-- wardby_proxy here and re-run the bootstrap. Each statement ends with a
-- "-- ;;" line, which is how the test splits the file.
--
-- The bootstrap runs the whole file in one transaction: a refused statement
-- leaves nothing applied. Order: group roles, then memberships, then
-- privileges. Grants on named tables apply only once those tables exist, so the
-- file also runs on a fresh, unmigrated database (for the migrator's
-- membership); running it again after the migrations applies the rest.

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

-- The coding proxy: its budget ledger (src/providers/coding-proxy/prisma-ledger.ts)
-- and its package registry store (src/providers/coding-proxy/registry/prisma-store.ts).
GRANT USAGE ON SCHEMA public TO wardby_proxy;
-- ;;

-- Grants on named tables, each only once its table exists (skipped on an
-- unmigrated database; re-run the bootstrap after the migrations). The app
-- loses the migration history the default privileges gave it: only the
-- migrator, acting as the owner, has any business there.
DO $$ BEGIN
  IF to_regclass('public."CodingProxySession"') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO wardby_proxy', 'CodingProxySession');
  END IF;
  IF to_regclass('public."CodingProxyRequest"') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO wardby_proxy', 'CodingProxyRequest');
  END IF;
  IF to_regclass('public."Run"') IS NOT NULL THEN
    EXECUTE format('GRANT UPDATE (%I, %I, %I), SELECT (%I) ON public.%I TO wardby_proxy',
      'tokensIn', 'tokensOut', 'costUsd', 'id', 'Run');
  END IF;
  -- The package registry (src/providers/coding-proxy/registry/prisma-store.ts):
  -- it reads a run's package allowlist and policy snapshot, and records the
  -- allowances and fetches of that run. It never updates or deletes either.
  IF to_regclass('public."CodingRun"') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT (%I, %I, %I) ON public.%I TO wardby_proxy',
      'runId', 'packageAllowlist', 'packagePolicy', 'CodingRun');
  END IF;
  IF to_regclass('public."RegistryAllowance"') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO wardby_proxy', 'RegistryAllowance');
  END IF;
  IF to_regclass('public."RegistryFetch"') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO wardby_proxy', 'RegistryFetch');
  END IF;
  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON public.%I FROM wardby_app', '_prisma_migrations');
  END IF;
END $$;
-- ;;
