-- The built-in `redis` "7" service now runs Valkey 8.1 (BSD-3), a drop-in fork of Redis 7.2, instead
-- of Redis 7.4 (RSALv2/SSPLv1). Same port, readiness command (the image ships redis-cli), data
-- directory and variables; only the image changes.
UPDATE "CodingService"
SET "image" = 'docker.io/valkey/valkey@sha256:8f836008e0986c36adf50da714c7060cf689dbb335f61fe077939d90fa650809',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'builtin-redis-7' AND "builtin" = true;
