-- A catalog entry's Substrate-only image: the Substrate job launcher runs it instead of "image"
-- (Docker and Kubernetes never read it). Null: Substrate runs "image".
ALTER TABLE "CodingService" ADD COLUMN "substrateImage" TEXT;

-- The built-in postgres and mysql entries run a non-root image on Substrate (CloudNativePG
-- postgresql 15.19 / 16.15 / 17.11, percona-server 8.4.11-12), pinned by index digest.
UPDATE "CodingService" SET "substrateImage" = 'ghcr.io/cloudnative-pg/postgresql@sha256:11274300143f02d369ea2ff6082b028b6b662915f06bf59f26b808b53823475a'
  WHERE "builtin" = true AND "name" = 'postgres' AND "version" = '15';
UPDATE "CodingService" SET "substrateImage" = 'ghcr.io/cloudnative-pg/postgresql@sha256:34cd4159d07b3410a1b29da35072e2e927a0905e717a61afa3814624a2e8859a'
  WHERE "builtin" = true AND "name" = 'postgres' AND "version" = '16';
UPDATE "CodingService" SET "substrateImage" = 'ghcr.io/cloudnative-pg/postgresql@sha256:70664ebcfa1100361b5bdc28bbf06fdbe08db2dc4ad7bd14de33c5e05fe8ea8e'
  WHERE "builtin" = true AND "name" = 'postgres' AND "version" = '17';
UPDATE "CodingService" SET "substrateImage" = 'docker.io/percona/percona-server@sha256:e95917e6dc1242a773e35a1d93f2ede275c9b48eab4354c446d64cefe6bb79be'
  WHERE "builtin" = true AND "name" = 'mysql' AND "version" = '8';

-- Their Substrate start commands: a script that initialises and runs the service as that image's
-- user (reading the entry's serviceEnv by name only), and redis-server started directly.
UPDATE "CodingService" SET "startCommand" = '["/bin/sh","-c","set -u; if [ ! -s \"$PGDATA/PG_VERSION\" ]; then pw=\"/tmp/.wardby-pgpw.$$\"; (umask 077 && printf ''%s\\n'' \"$POSTGRES_PASSWORD\" > \"$pw\") || exit 1; initdb -D \"$PGDATA\" -U \"$POSTGRES_USER\" --pwfile=\"$pw\" --auth-host=scram-sha-256 --auth-local=trust; rc=$?; rm -f \"$pw\"; [ \"$rc\" -eq 0 ] || exit \"$rc\"; fi; postgres -D \"$PGDATA\" -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp & pid=$!; until pg_isready -q -h 127.0.0.1; do kill -0 \"$pid\" 2>/dev/null || exit 1; sleep 1; done; export PGPASSWORD=\"$POSTGRES_PASSWORD\"; psql -h 127.0.0.1 -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -Atc ''select 1'' >/dev/null 2>&1 || createdb -h 127.0.0.1 -U \"$POSTGRES_USER\" \"$POSTGRES_DB\" || exit 1; unset PGPASSWORD; wait \"$pid\""]'::jsonb
  WHERE "builtin" = true AND "name" = 'postgres';
UPDATE "CodingService" SET "startCommand" = '["redis-server","--dir","/data"]'::jsonb
  WHERE "builtin" = true AND "name" = 'redis';
UPDATE "CodingService" SET "startCommand" = '["/bin/sh","-c","export PERCONA_TELEMETRY_DISABLE=1; set -u; O=\"--datadir=/var/lib/mysql/data --socket=/tmp/mysqld.sock --pid-file=/tmp/mysqld.pid --secure-file-priv=/tmp --log-error=/tmp/mysqld.err\"; init=0; if [ ! -d /var/lib/mysql/data/mysql ]; then mysqld $O --initialize-insecure || exit 1; init=1; fi; mysqld $O --bind-address=127.0.0.1 --port=3306 --mysqlx=OFF & pid=$!; until mysqladmin --socket=/tmp/mysqld.sock -uroot ping --silent >/dev/null 2>&1; do kill -0 \"$pid\" 2>/dev/null || exit 1; sleep 1; done; lit() { printf ''%s'' \"$1\" | sed -e ''s/\\\\/\\\\\\\\/g'' -e \"s/''/''''/g\"; }; if [ \"$init\" = 1 ]; then d=$(printf ''%s'' \"$MYSQL_DATABASE\" | sed ''s/`/``/g''); u=$(lit \"$MYSQL_USER\"); p=$(lit \"$MYSQL_PASSWORD\"); r=$(lit \"$MYSQL_ROOT_PASSWORD\"); printf ''%s\\n'' \"CREATE DATABASE IF NOT EXISTS \\`$d\\`;\" \"CREATE USER IF NOT EXISTS ''$u''@''%'' IDENTIFIED BY ''$p'';\" \"GRANT ALL ON \\`$d\\`.* TO ''$u''@''%'';\" \"ALTER USER ''root''@''localhost'' IDENTIFIED BY ''$r'';\" | mysql --socket=/tmp/mysqld.sock -uroot || exit 1; fi; wait \"$pid\""]'::jsonb
  WHERE "builtin" = true AND "name" = 'mysql';
