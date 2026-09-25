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

Changes to coding workers, authentication, budgets, isolation, migrations, or
release boundaries should include focused negative tests. Do not commit secrets,
private keys, production data, prompts, repository contents, or generated
worker artifacts.

Keep pull requests narrow and explain the user-visible behavior, security
impact, and verification performed. Sign commits with `git commit -s` to
certify the [Developer Certificate of Origin](https://developercertificate.org/).

Report suspected vulnerabilities through the private process in
[SECURITY.md](SECURITY.md), not a public issue.
