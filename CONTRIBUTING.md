# Contributing to Wardby

Wardby welcomes focused bug fixes, tests, documentation improvements, and
portable deployment enhancements.

## Development setup

1. Install the Node.js version in `.nvmrc` and Docker.
2. Run `npm ci`.
3. Copy `.env.example` to `.env` and use test-only credentials.
4. Start PostgreSQL with `npm run db:up` and apply migrations with
   `npm run prisma:migrate`.
5. `npm ci` already generated the Prisma client (the `prepare` script) into
   `src/generated/prisma`, which is git-ignored. Regenerate it with
   `npm run prisma:generate` after any `prisma/schema.prisma` change, before
   `npm run typecheck` or `npm test`: both fail if the client is missing or
   stale.

Before opening a pull request, run:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

`format:check` runs Prettier over Markdown as well as code; fix failures with
`npx prettier --write <paths>`.

`npm test` runs every test. While you work, run only the category your change
needs; each script builds what its tests depend on first:

| Script                     | Runs                                                                | Needs                                                                   |
| -------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `npm run test:unit`        | `src/**/*.test.ts` that are not in a category below                 | Nothing                                                                 |
| `npm run test:database`    | `*.database.test.*`                                                 | Postgres: `npm run db:up`, `DATABASE_URL`, `npm run prisma:migrate`     |
| `npm run test:browser`     | `*.browser*.test.ts`                                                | Postgres as above, and `npx playwright install chromium`                |
| `npm run test:integration` | `*.integration.test.ts`, `*.docker.test.ts`, `*.acceptance.test.ts` | Docker or a cluster; most are opt-in through a `WARDBY_*_TEST` variable |
| `npm run test:tools`       | `tools/`, `deploy/` and `scripts/` tests                            | Nothing                                                                 |

Suites that cannot find `DATABASE_URL` or Chromium skip instead of failing, so a
category run can pass without running them. The `unit` category also holds about
45 files that need `DATABASE_URL` but do not have `.database` in their name;
they skip without it, so run `npm test` against Postgres before opening a pull
request.

Changes to coding workers, authentication, budgets, isolation, migrations, or
release boundaries should include focused negative tests. Do not commit secrets,
private keys, production data, prompts, repository contents, or generated
worker artifacts.

Keep pull requests narrow and explain the user-visible behavior, security
impact, and verification performed. Sign commits with `git commit -s` to
certify the [Developer Certificate of Origin](https://developercertificate.org/).

Report suspected vulnerabilities through the private process in
[SECURITY.md](SECURITY.md), not a public issue.
