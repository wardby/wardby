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
 */
import type { CodingServiceDefinition } from "./catalog.js";

function postgres(version: string, digest: string): CodingServiceDefinition {
  return {
    name: "postgres",
    version,
    kind: "sidecar",
    image: `docker.io/library/postgres@${digest}`,
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
    resources: { cpuMillicores: 500, memoryMib: 512, diskMib: 1024 },
    dataPath: "/var/lib/postgresql/data",
    writablePaths: ["/var/run/postgresql", "/tmp"],
  };
}

export const BUILTIN_CODING_SERVICES: readonly CodingServiceDefinition[] = Object.freeze([
  postgres("15", "sha256:724292da1f2e50bdccfc3302ce75bbba7f4a6076701b588cc795fcac65683550"),
  postgres("16", "sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54"),
  postgres("17", "sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f"),
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
    resources: { cpuMillicores: 250, memoryMib: 256, diskMib: 256 },
    dataPath: "/data",
    writablePaths: [],
  },
  {
    name: "mysql",
    version: "8",
    kind: "sidecar",
    image: "docker.io/library/mysql@sha256:0744ee5ef89ce6ccfa13de3e579fe6b9e27f93dd70da9c06d2c908b1b193fb8d",
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
    resources: { cpuMillicores: 500, memoryMib: 1024, diskMib: 2048 },
    dataPath: "/var/lib/mysql",
    writablePaths: ["/var/run/mysqld", "/tmp"],
  },
]);
