---
id: errors/database-auth-invalid
title: Database authentication is misconfigured
summary: DATABASE_AUTH or the database URL does not meet the rules for the chosen authentication mode, so the process refused to start.
audience: operator
tags: [error, database, rds, iam, deploy, database_auth_invalid, rds-iam]
appliesTo: ">=0.6.0"
---

# Database authentication is misconfigured

`database_auth_invalid` means `DATABASE_AUTH` is not valid, or `DATABASE_AUTH=rds-iam` is set and `DATABASE_URL` (or `DBOS_SYSTEM_DATABASE_URL`) does not meet its rules. Wardby checks this when the process starts, so every `wardby` command fails with it, not only the server. The message names the problem; it never includes the URL, credentials, or parameter values.

`DATABASE_AUTH` is `password` (the default; the password is in `DATABASE_URL`) or `rds-iam` (Amazon RDS IAM database authentication, where the password is a short-lived token signed with the workload's AWS credentials). Any other value is refused.

Under `rds-iam` check each of these:

1. `DATABASE_URL` starts with `postgresql://` or `postgres://`, has a user, and has no password.
2. `AWS_REGION` or `DATABASE_AWS_REGION` is set (`DATABASE_AWS_REGION` wins).
3. The URL has `sslmode=verify-full` and `sslrootcert=<path to the RDS CA bundle>`, and that file exists and is readable in the container. An unreadable file is reported with its error code, such as `ENOENT` for a missing file or `EACCES` for one the process cannot read.
4. Only supported parameters are present: `sslmode`, `sslrootcert`, `application_name`, `fallback_application_name`, `options`, `client_encoding`, `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `query_timeout`, `connection_limit`, `pool_timeout`, `connect_timeout`, `schema`. Anything else (`sslcert`, `sslkey`, `ssl`, `host`, `pgbouncer`, ...) is refused by name; remove it.
5. User and database names in the URL are correctly percent-encoded.

If the code is not raised but connections are rejected, the configuration is valid and the problem is on the AWS side: the workload's IAM role needs `rds-db:connect` for the database user, and that user needs the `rds_iam` role in the database.

`prisma migrate deploy` and `dbos schema` take a URL and do not follow `DATABASE_AUTH`. Mint a short-lived URL with the migration image's helper: `DATABASE_URL="$(node scripts/rds-iam-url.mjs)" && export DATABASE_URL && npm run prisma:migrate && npm run dbos:migrate`. It reports the same `database_auth_invalid` errors for the checks it shares. `wardby quickstart` does not support `rds-iam`.

See [Database authentication](../../docs/security-deployment.md#database-authentication).
