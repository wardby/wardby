/**
 * The services wardby ships in its catalog. Migration
 * 20260927050000_coding_run_services seeds exactly these rows
 * (builtins.database.test.ts holds the two together); a later release changes
 * them with a new migration and a change here.
 *
 * Each image is the official Docker Hub image pinned by its multi-architecture
 * index digest, resolved with
 * `docker buildx imagetools inspect docker.io/library/<name>:<tag>`; `redis`
 * uses Valkey's official image (see its entry).
 *
 * A sidecar runs as the run pod's non-root uid with a read-only root
 * filesystem, so each entry names every directory its image writes to: the
 * data directory and, for the databases, the socket directory and /tmp (the
 * official entrypoints write an nss_wrapper passwd file there for an arbitrary
 * uid). Postgres keeps PGDATA one level below its volume so the entrypoint can
 * create it owned by that uid. Readiness probes TCP on 127.0.0.1, not the Unix
 * socket: both database entrypoints first run a temporary socket-only server to
 * initialize, and only the final server listens on TCP. Variables use
 * 127.0.0.1 rather than localhost so no client tries the IPv6 loopback first.
 *
 * `startCommand` is the Substrate start command: the image's ENTRYPOINT + CMD,
 * or for an entry with substrateImage, a script that initialises and runs the
 * service as that image's non-root user. Only the Substrate launcher uses it
 * and `substrateImage`; Docker and Kubernetes run `image` with its own
 * entrypoint. Substrate runs a service container as its image's default user
 * with no capabilities for chown or a user switch, so the official postgres
 * and mysql entrypoints cannot start there:
 *
 * - postgres runs the CloudNativePG image (non-root uid 26, Apache-2.0; PGDG
 *   binaries on PATH, no entrypoint), pinned by index digest from
 *   `docker buildx imagetools inspect ghcr.io/cloudnative-pg/postgresql:<major>`:
 *   15.19, 16.15 and 17.11.
 * - redis keeps its Valkey image, started as `redis-server` directly (it runs
 *   as uid 0 and needs no chown), without docker-entrypoint.sh.
 * - mysql runs `percona/percona-server` 8.4.11-12 (non-root uid 1001).
 *
 * The scripts read the entry's serviceEnv by name only (the launcher's start
 * script exports it first); no value is written into them. Each is one line:
 * a startCommand argument may not hold a newline. Each writes the file named by
 * $WARDBY_SERVICE_SETUP_DONE (set by the launcher's start script) once its setup
 * is done: the readiness command alone passes before createdb has run or the
 * mysql user exists (mysqladmin ping answers even "Access denied").
 */
import type { CodingServiceDefinition } from "./catalog.js";

/**
 * Initialise PGDATA on first start (the password reaches initdb through a 0600 file in /tmp, removed
 * at once), run postgres on 127.0.0.1, create POSTGRES_DB once it answers, mark setup done, and stay
 * in the foreground.
 */
export const POSTGRES_SUBSTRATE_SCRIPT = [
  "set -u;",
  'if [ ! -s "$PGDATA/PG_VERSION" ]; then',
  'pw="/tmp/.wardby-pgpw.$$";',
  String.raw`(umask 077 && printf '%s\n' "$POSTGRES_PASSWORD" > "$pw") || exit 1;`,
  'initdb -D "$PGDATA" -U "$POSTGRES_USER" --pwfile="$pw" --auth-host=scram-sha-256 --auth-local=trust;',
  'rc=$?; rm -f "$pw"; [ "$rc" -eq 0 ] || exit "$rc";',
  "fi;",
  'postgres -D "$PGDATA" -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp & pid=$!;',
  'until pg_isready -q -h 127.0.0.1; do kill -0 "$pid" 2>/dev/null || exit 1; sleep 1; done;',
  'export PGPASSWORD="$POSTGRES_PASSWORD";',
  `psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'select 1' >/dev/null 2>&1 || createdb -h 127.0.0.1 -U "$POSTGRES_USER" "$POSTGRES_DB" || exit 1;`,
  "unset PGPASSWORD;",
  ': > "$WARDBY_SERVICE_SETUP_DONE" || exit 1;',
  'wait "$pid"',
].join(" ");

/**
 * Initialise the datadir on first start, run mysqld on 127.0.0.1, and on that first start create
 * MYSQL_DATABASE and MYSQL_USER and set root's password over the root socket, with the SQL on stdin
 * (values SQL-quoted, never in an argument); then mark setup done and stay in the foreground.
 * Telemetry is off.
 */
export const MYSQL_SUBSTRATE_SCRIPT = [
  "export PERCONA_TELEMETRY_DISABLE=1; set -u;",
  'O="--datadir=/var/lib/mysql/data --socket=/tmp/mysqld.sock --pid-file=/tmp/mysqld.pid --secure-file-priv=/tmp --log-error=/tmp/mysqld.err";',
  "init=0;",
  "if [ ! -d /var/lib/mysql/data/mysql ]; then mysqld $O --initialize-insecure || exit 1; init=1; fi;",
  "mysqld $O --bind-address=127.0.0.1 --port=3306 --mysqlx=OFF & pid=$!;",
  'until mysqladmin --socket=/tmp/mysqld.sock -uroot ping --silent >/dev/null 2>&1; do kill -0 "$pid" 2>/dev/null || exit 1; sleep 1; done;',
  String.raw`lit() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/''/g"; };`,
  'if [ "$init" = 1 ]; then',
  'd=$(printf \'%s\' "$MYSQL_DATABASE" | sed \'s/`/``/g\'); u=$(lit "$MYSQL_USER"); p=$(lit "$MYSQL_PASSWORD"); r=$(lit "$MYSQL_ROOT_PASSWORD");',
  String.raw`printf '%s\n' "CREATE DATABASE IF NOT EXISTS \`$d\`;" "CREATE USER IF NOT EXISTS '$u'@'%' IDENTIFIED BY '$p';" "GRANT ALL ON \`$d\`.* TO '$u'@'%';" "ALTER USER 'root'@'localhost' IDENTIFIED BY '$r';" | mysql --socket=/tmp/mysqld.sock -uroot || exit 1;`,
  "fi;",
  ': > "$WARDBY_SERVICE_SETUP_DONE" || exit 1;',
  'wait "$pid"',
].join(" ");

function postgres(version: string, digest: string, substrateDigest: string): CodingServiceDefinition {
  return {
    name: "postgres",
    version,
    kind: "sidecar",
    image: `docker.io/library/postgres@${digest}`,
    substrateImage: `ghcr.io/cloudnative-pg/postgresql@${substrateDigest}`,
    port: 5432,
    serviceEnv: {
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "test",
      PGDATA: "/var/lib/postgresql/data/pgdata",
    },
    testEnv: {
      DATABASE_URL: "postgres://test:test@127.0.0.1:5432/test",
      PGHOST: "127.0.0.1",
      PGPORT: "5432",
      PGUSER: "test",
      PGPASSWORD: "test",
      PGDATABASE: "test",
    },
    readiness: {
      command: ["pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "test", "-d", "test"],
      periodSeconds: 2,
      timeoutSeconds: 2,
      failureThreshold: 30,
    },
    startCommand: ["/bin/sh", "-c", POSTGRES_SUBSTRATE_SCRIPT],
    resources: { cpuMillicores: 500, memoryMib: 512, diskMib: 1024 },
    dataPath: "/var/lib/postgresql/data",
    writablePaths: ["/var/run/postgresql", "/tmp"],
  };
}

export const BUILTIN_CODING_SERVICES: readonly CodingServiceDefinition[] = Object.freeze([
  postgres(
    "15",
    "sha256:724292da1f2e50bdccfc3302ce75bbba7f4a6076701b588cc795fcac65683550",
    "sha256:11274300143f02d369ea2ff6082b028b6b662915f06bf59f26b808b53823475a",
  ),
  postgres(
    "16",
    "sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54",
    "sha256:34cd4159d07b3410a1b29da35072e2e927a0905e717a61afa3814624a2e8859a",
  ),
  postgres(
    "17",
    "sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f",
    "sha256:70664ebcfa1100361b5bdc28bbf06fdbe08db2dc4ad7bd14de33c5e05fe8ea8e",
  ),
  // `redis` "7" runs Valkey 8.1 (BSD-3), the Linux Foundation fork of Redis 7.2: the same protocol,
  // commands and clients, and its image ships `redis-cli`/`redis-server`. Redis itself left BSD at 7.4
  // (RSALv2/SSPLv1). Resolved with `docker buildx imagetools inspect docker.io/valkey/valkey:8`.
  {
    name: "redis",
    version: "7",
    kind: "sidecar",
    image: "docker.io/valkey/valkey@sha256:8f836008e0986c36adf50da714c7060cf689dbb335f61fe077939d90fa650809",
    port: 6379,
    serviceEnv: {},
    testEnv: { REDIS_URL: "redis://127.0.0.1:6379/0", REDIS_HOST: "127.0.0.1", REDIS_PORT: "6379" },
    readiness: {
      command: ["redis-cli", "-h", "127.0.0.1", "-p", "6379", "ping"],
      periodSeconds: 1,
      timeoutSeconds: 2,
      failureThreshold: 30,
    },
    startCommand: ["redis-server", "--dir", "/data"],
    resources: { cpuMillicores: 250, memoryMib: 256, diskMib: 256 },
    dataPath: "/data",
    writablePaths: [],
  },
  {
    name: "mysql",
    version: "8",
    kind: "sidecar",
    image: "docker.io/library/mysql@sha256:0744ee5ef89ce6ccfa13de3e579fe6b9e27f93dd70da9c06d2c908b1b193fb8d",
    substrateImage:
      "docker.io/percona/percona-server@sha256:e95917e6dc1242a773e35a1d93f2ede275c9b48eab4354c446d64cefe6bb79be",
    port: 3306,
    serviceEnv: {
      MYSQL_ROOT_PASSWORD: "test",
      MYSQL_DATABASE: "test",
      MYSQL_USER: "test",
      MYSQL_PASSWORD: "test",
    },
    testEnv: {
      DATABASE_URL: "mysql://test:test@127.0.0.1:3306/test",
      MYSQL_HOST: "127.0.0.1",
      MYSQL_TCP_PORT: "3306",
      MYSQL_USER: "test",
      MYSQL_PASSWORD: "test",
      MYSQL_DATABASE: "test",
    },
    readiness: {
      command: ["mysqladmin", "ping", "-h", "127.0.0.1", "-P", "3306", "-utest", "-ptest", "--silent"],
      periodSeconds: 2,
      timeoutSeconds: 3,
      failureThreshold: 45,
    },
    startCommand: ["/bin/sh", "-c", MYSQL_SUBSTRATE_SCRIPT],
    resources: { cpuMillicores: 500, memoryMib: 1024, diskMib: 2048 },
    dataPath: "/var/lib/mysql",
    writablePaths: ["/var/run/mysqld", "/tmp"],
  },
]);
