# Release verification

Run release checks against the exact commit and dependency lockfile that will
be published. Database-backed checks require a disposable, migrated PostgreSQL
database through `DATABASE_URL`.

```sh
npm ci
npm run prisma:generate
npm run prisma:migrate
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run test:production-boundary
npm run test:package
node scripts/security-audit.mjs
```

For coding-agent releases, also run:

```sh
npm run test:phase5:database
npm run worker:image:local
npm run test:docker-isolation
npm run test:docker-job
npm run verify:claude-code
```

The GitHub `Security checks` workflow builds the worker-image matrix, creates
SPDX SBOMs, scans images, replays migrations, and exercises the database and
browser-backed suites. A release is acceptable only when required checks pass
on the release commit and its production images are addressed by immutable
digest.

Live coding smoke tests are opt-in because they spend provider credit and
create a branch and draft pull request. Use a dedicated fixture repository, a
repository-scoped GitHub App installation, and a deliberately small budget.
Verify the requested diff, terminal outcome, cost, resource cleanup, and branch
cleanup. See [local coding-agent setup](coding-agent-setup.md).

Before production deployment, review [runtime architecture](architecture-runtime.md),
[coding-worker isolation](coding-worker-isolation.md), and the
[security deployment guide](security-deployment.md). A self-hosted operator is
responsible for equivalent edge, network, database, secret-management,
monitoring, backup, and recovery controls in the selected platform.
