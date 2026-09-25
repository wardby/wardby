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

-- The app: data, never schema.
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

-- The coding proxy: its budget ledger only (src/providers/coding-proxy/prisma-ledger.ts).
GRANT USAGE ON SCHEMA public TO wardby_proxy;
-- ;;
GRANT SELECT, INSERT, UPDATE ON "CodingProxySession", "CodingProxyRequest" TO wardby_proxy;
-- ;;
GRANT UPDATE ("tokensIn", "tokensOut", "costUsd"), SELECT ("id") ON "Run" TO wardby_proxy;
-- ;;

GRANT wardby_app TO "{{app}}";
-- ;;
GRANT wardby_proxy TO "{{proxy}}";
-- ;;
