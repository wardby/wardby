# AGENTS.md

**Read [`CLAUDE.md`](CLAUDE.md) before doing anything else, and follow it.**
Its rules bind every agent working in this repository, not only Claude: signed-off
commits, the checks to run before committing, Prisma migrations and the drift check,
pricing tables, deployment modules, operator-facing docs, and the docs + help check
for every feature. `CLAUDE.md` is the single home for those rules; this file only
points to it and adds notes about the coding-run sandbox.

## Tests in a wardby coding run

- **PostgreSQL** is started for you (`.wardby/services.yaml`). `DATABASE_URL` points
  at an empty database: run `npx prisma migrate deploy` before the database tests
  (`*.database.test.ts`), which skip when `DATABASE_URL` is unset.
- **`SECRET_APP_KEY`:** some database tests need it. Use the test-only value from
  `.github/workflows/security.yml`; never a real key.
- **Drift check:** `CLAUDE.md` runs it with `docker exec`, which a coding run does
  not have. Create the shadow database through Prisma instead (one statement per
  call, since `DROP DATABASE` can't run in a transaction), run the check, then
  drop it:

  ```bash
  echo 'DROP DATABASE IF EXISTS wardby_shadow;' | npx prisma db execute --stdin
  echo 'CREATE DATABASE wardby_shadow;' | npx prisma db execute --stdin
  SHADOW_DATABASE_URL="${DATABASE_URL%/*}/wardby_shadow" npx prisma migrate diff \
    --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script --exit-code
  echo 'DROP DATABASE IF EXISTS wardby_shadow;' | npx prisma db execute --stdin
  ```

  Clean is `-- This is an empty migration.`, exactly as `CLAUDE.md` says.

- If a check can't run in the sandbox, say which and why in the pull request; never
  report it as passing.

## Architecture knowledge

See [the architecture knowledge index](docs/knowledge/index.md) for cited
contracts and pitfalls relevant to repository changes.
