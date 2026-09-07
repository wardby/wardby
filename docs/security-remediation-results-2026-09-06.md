# Security Remediation Results

Date: 2026-09-06
Repository: `/Users/chfields/Personal/reevo-run`
Status: secured self-hosted implementation approved and enabled on 2026-09-06.

## Release Update

The original candidate below was committed as `dca4648`. After independent
orchestration review and repeat verification, the owner approved removal of the
startup quarantine. SR-001, SR-002, SR-003, and SR-008 are closed at their code
and release gates. Production migration and deployment controls remain separate.

The owner accepted SR-009 on 2026-09-06 through 2026-10-06 for trusted build and
migration tooling only. `scripts/security-audit.mjs` permits only the exact
GHSA-ggr8-5vv4-36mx dependency chain and fails for new advisories or expiration;
the runtime artifact remains free of the affected packages.

Release verification passed all 398 current tests across 51 files with no skips,
including the migrated PostgreSQL tests and real Chrome OAuth flow. Typecheck,
build, and the time-bounded audit policy also passed.

## Original Candidate Outcome

The unsafe self-hosted issuance path is quarantined without an environment bypass.
Its replacement is implemented: operator-provisioned high-entropy login keys,
HMAC credential storage, server-side sessions, single-use cookie/session-bound CSRF,
explicit consent, public S256 PKCE clients, atomic opaque codes, rotating refresh
families with reuse revocation, and a credential-invalidating migration.
Delegating OAuth and stdio remain usable and their tests pass.

Subject validation, canonical Host/Origin checks, streaming request limits,
request/header timeouts, sanitized errors, per-hop SSRF checks, pinned DNS,
bounded host allocations, and owner-aware attached-tool projections are in place.
A final regression also bounds HTML link expansion before building its result.

| Findings                               | Current status                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR-004, SR-005, SR-006, SR-007, SR-010 | Closed at their local code/acceptance gates; independent release review and deployment verification are not implied.                                                                         |
| SR-001, SR-002, SR-003, SR-008         | Exploits mitigated by quarantine; secure replacement tests pass; remain pending independent auth/migration release review and production migration.                                          |
| SR-009                                 | Open in build/migration tooling. Runtime artifact excludes the affected packages. No compatible fixed Prisma 6 release was available; no downgrade or dependency-major override was applied. |

The original issue evidence and plan have been preserved and annotated in
[the register](security-review-2026-09-06.md) and
[the implementation plan](security-remediation-plan-2026-09-06.md).
No changes were committed, staged, deployed, or applied to a production database.
No unrelated existing files or changes were reverted. The two original untracked
security documents were updated in place and remain untracked.

## Verification

Verification used isolated Node 22 (the shell's Node 20.11 is unsupported),
PostgreSQL 16 in disposable container `reevo-security-20260906`, and an isolated
headless installed-Chrome profile. Database-backed tests were run with
`DATABASE_URL` explicitly set, overriding the repository's existing environment.
The original local PostgreSQL service on port 55432 was not changed.
After verification, the disposable container was stopped, not deleted. Restart
it with `docker start reevo-security-20260906` to repeat database checks. The
two reviewed local images remain available; neither was deployed.

| Final check                              | Pass | Fail | Skip | Result                                                                                                     |
| ---------------------------------------- | ---: | ---: | ---: | ---------------------------------------------------------------------------------------------------------- |
| Full suite, 52 files                     |  400 |    0 |    0 | Includes DB auth/concurrency, browser, delegated HTTP, stdio, sandbox, ownership, and body/timeout checks. |
| Focused security suite, 7 files          |  115 |    0 |    0 | Overlaps the full suite; do not add these counts together.                                                 |
| Live OpenAI contract tests               |    2 |    0 |    0 | Real streaming completion and tool-call reconstruction.                                                    |
| Typecheck                                |    1 |    0 |    0 | TypeScript passes.                                                                                         |
| Application build                        |    1 |    0 |    0 | Vendor bundle and production TypeScript build pass.                                                        |
| Prisma generate, validate, status, drift |    4 |    0 |    0 | Client 6.19.3; nine migrations applied; exact output: `-- This is an empty migration.`                     |
| Migration/recovery rehearsal assertions  |    7 |    0 |    0 | Eleven unrelated tables preserved, old OAuth data removed, safe backup restored and re-migrated.           |
| Allocation-check assertions              |    4 |    0 |    0 | Endless stream stops after 8,519,680 bytes; observed peak RSS increase 9,928,704 bytes (9.47 MiB).         |
| Runtime image build/smoke/audit          |    3 |    0 |    0 | uid 1000, database reachable, affected tooling absent, zero shipped-subset npm vulnerabilities.            |
| Migration image build/deploy smoke       |    2 |    0 |    0 | Trusted separate tooling image works against the disposable database; no pending migrations.               |
| Repository dependency audits             |    0 |    2 |    0 | Each reports 3 high-severity affected packages from one advisory, GHSA-ggr8-5vv4-36mx.                     |
| Dependency inventory                     |    1 |    0 |    0 | `npm ls --all --json` archived alongside this report.                                                      |

### Commands

The following shell setup describes the actual isolated environment used. The
password below is synthetic and valid only for the disposable local test DB.

```sh
cd /Users/chfields/Personal/reevo-run
export DATABASE_URL=postgresql://reevo:reevo-test-only@127.0.0.1:55439/reevo_security
export SECURITY_BROWSER_CHANNEL=chrome
npm exec --yes --package=node@22 -- npm run typecheck
npm exec --yes --package=node@22 -- npm test
npm exec --yes --package=node@22 -- npm run test:contract
npm exec --yes --package=node@22 -- npm run build
npm exec --yes --package=node@22 -- npm run prisma:generate
npm exec --yes --package=node@22 -- npx prisma validate
npm exec --yes --package=node@22 -- npx prisma migrate status
npm exec --yes --package=node@22 -- npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url postgresql://reevo:reevo-test-only@127.0.0.1:55439/reevo_security_shadow \
  --script
npm exec --yes --package=node@22 -- npx vitest run \
  src/sandbox/host-functions.test.ts src/sandbox/safe-fetch.test.ts \
  src/mcp/transport/http-security.test.ts src/providers/auth/self-hosted.test.ts \
  src/mcp/auth/self-hosted/browser.test.ts src/mcp/tools/tools.test.ts \
  src/providers/auth/subject.test.ts
node scripts/security-migration-rehearsal.mjs
npm exec --yes --package=node@22 -- node --expose-gc scripts/security-allocation-check.mjs
node scripts/security-audit.mjs
npm ls --all --json
git diff --check
docker build -f deploy/Dockerfile --target runtime -t reevo-security-review:20260906 .
docker build -f deploy/Dockerfile --target migration -t reevo-security-migration:20260906 .
docker run --rm reevo-security-review:20260906 npm audit --omit=peer --json
docker run --rm \
  --env DATABASE_URL=postgresql://reevo:reevo-test-only@host.docker.internal:55439/reevo_security \
  reevo-security-migration:20260906 npm run prisma:migrate
```

`security-audit.mjs` runs both `npm audit --omit=dev --json` and
`npm audit --json`, preserving a failing exit status. The production audit is
against the image's actual dependency selection (`--omit=peer`); plain repository
`--omit=dev` is not equivalent because Prisma's optional peer can pull CLI tooling.
The image smoke test used Node assertions for uid 1000 and absence of
`node_modules/prisma`, `node_modules/@prisma/config`, and
`node_modules/deepmerge-ts`, followed by a real Prisma query and disconnect.

Runtime image inspected: `sha256:5572665284798abd441cbcffb0113f6058d80deb44638ce42013c7cafda4b276`.
Migration image inspected: `sha256:0d29fbb402255f78df774b9cca765adda4ef019753d6f62b2aea0e5e8889a68c`.
[Archived dependency inventory](security-dependency-tree-2026-09-06.json).
The new CI workflow was written, not remotely dispatched; its audits intentionally
remain red until SR-009 is resolved or an explicit policy is approved.

### Red Tests and Environment Failures

Regression tests were written before or with their fixes. The final HTML
extraction regression was explicitly run before the fix: 1 failed, 16 filtered
out; it then passed in the focused and full suites. An earlier full run had
398 passes/1 failure from the oversized-upload client racing an early socket
close. The test now verifies early Content-Length rejection before uploading,
streams chunked data incrementally, and still requires an actual HTTP 413.
The final suite has no unresolved functional failure.

A real Chrome test exposed `Origin:null` on native form POSTs under
`Referrer-Policy:no-referrer`. Forms now use a per-response CSP-nonce script and
same-origin fetch; strict Origin and CSRF checks remain intact. The final browser
flow passed. Playwright's bundled Chromium download failed after CDN timeouts;
installed Chrome was used instead, not a skipped browser test. The installer also
removed older cached Playwright browser revisions; reinstall the needed browser
revision if another project depended on that cache. Historical nested worktree
tests are excluded by the root suite's explicit `src/**` include; no nested
checkout was edited. Existing token-calibration and SDK notification warnings
remain non-failing and do not contain live credentials.

## Migration and Compatibility

`20260906040000_secure_self_hosted_oauth` is a handwritten, atomic migration.
It deliberately drops and recreates legacy OAuthClient/OAuthGrant and adds
AuthUser, AuthLoginKey, AuthSession, AuthFormChallenge, OAuthAuthorizationRequest,
OAuthAuthorizationCode, OAuthFamily, and AuthRateLimit. SQL and Prisma definitions
match exactly. Already-applied historical migrations were not edited.

All old clients, codes, access tokens, and refresh tokens become unusable.
All users need operator-provisioned login keys; all clients must register again
as public S256 PKCE clients. Hash/signing keys are independent 32-byte secrets
encoded as 64 hex characters. Refresh reuse revokes the family and its access
tokens; retries after an uncertain refresh response require reauthorization.
Owners still receive tool source/schema; other public readers now receive only
id/name/description. New request, parser, datastore, secret, output, and execution
limits can reject previously accepted oversized workloads. Node 22.12+ is now
required. Vitest/esbuild development advisories were fixed by supported upgrades.
Prisma CLI and client remain aligned at 6.19.3.

The migration was applied only in disposable verification databases. The
rehearsal preserved representative principals, agents, tools, runs, datastore
values, encrypted-secret placeholders, attachments, webhooks, tasks, and leases.
Restoring the old OAuth contents would resurrect compromised credentials, so
that unsafe rollback was not performed. Safe recovery restores unrelated data,
creates empty legacy OAuth placeholders, then reapplies the secure migration.

## Remaining Gates and Secure Alternatives

- Independent reviewer: inspect identity derivation, CSRF, code consumption, family rotation/reuse, migration/recovery, and SSRF. No independent subagent was available. Quarantine remains until that gate passes; there is no production bypass.
- Prisma advisory: no supported compatible fixed Prisma 6 release was available. The proposed trusted-tooling-only exception expires 2026-10-06 and still needs owner acceptance. Runtime isolation does not fix the build/migration advisory.
- Production rollout: TLS and exact Host normalization, blocked direct ingress, private/metadata egress policy, least-privilege encrypted DB access, secret-manager keys, credential-safe monitoring, concurrency/memory limits, and backup/migration sign-off remain unverified locally.
- Database cancellation: Prisma 6 does not expose query AbortSignal support. Fetch/sleep/bridge delivery stop on cancellation; already-dispatched bounded DB work may complete. Use short statement/lock timeouts and bounded pools. A strictly cancellable DB adapter or isolated worker needs a separate architecture review; timeout does not roll back side effects.
- Browser/deployment: actual browser coverage used loopback HTTP development cookies. HTTPS cookie attributes are implemented, but the production TLS/proxy deployment must be tested before release. JavaScript is required for auth form submission.

See [deployment and recovery procedures](security-deployment.md) for operator
commands and exact compatibility/resource limits. No live keys were provisioned
or shared for deployment.

## Exact File Inventory

63 repository files were changed or added: 33 tracked files edited,
the two pre-existing untracked security documents updated, and 28
new files. Generated ignored `dist/`, vendor bundles, `node_modules/`, and disposable
Docker/test artifacts are not source changes and are not included below.

- Added: [.dockerignore](/Users/chfields/Personal/reevo-run/.dockerignore)
- Edited: [.env.example](/Users/chfields/Personal/reevo-run/.env.example)
- Added: [.github/workflows/security.yml](/Users/chfields/Personal/reevo-run/.github/workflows/security.yml)
- Added: [deploy/Dockerfile](/Users/chfields/Personal/reevo-run/deploy/Dockerfile)
- Added: [docs/security-dependency-tree-2026-09-06.json](/Users/chfields/Personal/reevo-run/docs/security-dependency-tree-2026-09-06.json)
- Added: [docs/security-deployment.md](/Users/chfields/Personal/reevo-run/docs/security-deployment.md)
- Updated pre-existing untracked: [docs/security-remediation-plan-2026-09-06.md](/Users/chfields/Personal/reevo-run/docs/security-remediation-plan-2026-09-06.md)
- Added: [docs/security-remediation-results-2026-09-06.md](/Users/chfields/Personal/reevo-run/docs/security-remediation-results-2026-09-06.md)
- Updated pre-existing untracked: [docs/security-review-2026-09-06.md](/Users/chfields/Personal/reevo-run/docs/security-review-2026-09-06.md)
- Edited: [package-lock.json](/Users/chfields/Personal/reevo-run/package-lock.json)
- Edited: [package.json](/Users/chfields/Personal/reevo-run/package.json)
- Added: [prisma/migrations/20260906040000_secure_self_hosted_oauth/migration.sql](/Users/chfields/Personal/reevo-run/prisma/migrations/20260906040000_secure_self_hosted_oauth/migration.sql)
- Edited: [prisma/schema.prisma](/Users/chfields/Personal/reevo-run/prisma/schema.prisma)
- Edited: [README.md](/Users/chfields/Personal/reevo-run/README.md)
- Added: [scripts/security-allocation-check.mjs](/Users/chfields/Personal/reevo-run/scripts/security-allocation-check.mjs)
- Added: [scripts/security-audit.mjs](/Users/chfields/Personal/reevo-run/scripts/security-audit.mjs)
- Added: [scripts/security-migration-rehearsal.mjs](/Users/chfields/Personal/reevo-run/scripts/security-migration-rehearsal.mjs)
- Edited: [src/cli.ts](/Users/chfields/Personal/reevo-run/src/cli.ts)
- Edited: [src/config/providers.ts](/Users/chfields/Personal/reevo-run/src/config/providers.ts)
- Added: [src/core/secrets.database.test.ts](/Users/chfields/Personal/reevo-run/src/core/secrets.database.test.ts)
- Edited: [src/core/secrets.ts](/Users/chfields/Personal/reevo-run/src/core/secrets.ts)
- Edited: [src/mcp/auth/principal.ts](/Users/chfields/Personal/reevo-run/src/mcp/auth/principal.ts)
- Edited: [src/mcp/auth/resource-server.ts](/Users/chfields/Personal/reevo-run/src/mcp/auth/resource-server.ts)
- Added: [src/mcp/auth/self-hosted/browser.test.ts](/Users/chfields/Personal/reevo-run/src/mcp/auth/self-hosted/browser.test.ts)
- Added: [src/mcp/auth/self-hosted/browser.ts](/Users/chfields/Personal/reevo-run/src/mcp/auth/self-hosted/browser.ts)
- Added: [src/mcp/auth/self-hosted/cli.ts](/Users/chfields/Personal/reevo-run/src/mcp/auth/self-hosted/cli.ts)
- Added: [src/mcp/auth/self-hosted/credentials.ts](/Users/chfields/Personal/reevo-run/src/mcp/auth/self-hosted/credentials.ts)
- Added: [src/mcp/auth/self-hosted/rate-limit.ts](/Users/chfields/Personal/reevo-run/src/mcp/auth/self-hosted/rate-limit.ts)
- Added: [src/mcp/auth/self-hosted/session.ts](/Users/chfields/Personal/reevo-run/src/mcp/auth/self-hosted/session.ts)
- Edited: [src/mcp/index.ts](/Users/chfields/Personal/reevo-run/src/mcp/index.ts)
- Edited: [src/mcp/integration.test.ts](/Users/chfields/Personal/reevo-run/src/mcp/integration.test.ts)
- Edited: [src/mcp/tools/tools.test.ts](/Users/chfields/Personal/reevo-run/src/mcp/tools/tools.test.ts)
- Edited: [src/mcp/tools/tools.ts](/Users/chfields/Personal/reevo-run/src/mcp/tools/tools.ts)
- Added: [src/mcp/transport/http-limits.test.ts](/Users/chfields/Personal/reevo-run/src/mcp/transport/http-limits.test.ts)
- Added: [src/mcp/transport/http-limits.ts](/Users/chfields/Personal/reevo-run/src/mcp/transport/http-limits.ts)
- Added: [src/mcp/transport/http-security.test.ts](/Users/chfields/Personal/reevo-run/src/mcp/transport/http-security.test.ts)
- Added for containment, then removed at release: `src/mcp/transport/quarantine.test.ts`
- Edited: [src/mcp/transport/streamable-http.test.ts](/Users/chfields/Personal/reevo-run/src/mcp/transport/streamable-http.test.ts)
- Edited: [src/mcp/transport/streamable-http.ts](/Users/chfields/Personal/reevo-run/src/mcp/transport/streamable-http.ts)
- Added: [src/providers/auth/authorization-server.ts](/Users/chfields/Personal/reevo-run/src/providers/auth/authorization-server.ts)
- Edited: [src/providers/auth/delegating.test.ts](/Users/chfields/Personal/reevo-run/src/providers/auth/delegating.test.ts)
- Edited: [src/providers/auth/delegating.ts](/Users/chfields/Personal/reevo-run/src/providers/auth/delegating.ts)
- Edited: [src/providers/auth/index.test.ts](/Users/chfields/Personal/reevo-run/src/providers/auth/index.test.ts)
- Edited: [src/providers/auth/index.ts](/Users/chfields/Personal/reevo-run/src/providers/auth/index.ts)
- Added for containment, then removed at release: `src/providers/auth/release-gate.ts`
- Edited: [src/providers/auth/self-hosted.test.ts](/Users/chfields/Personal/reevo-run/src/providers/auth/self-hosted.test.ts)
- Edited: [src/providers/auth/self-hosted.ts](/Users/chfields/Personal/reevo-run/src/providers/auth/self-hosted.ts)
- Added: [src/providers/auth/subject.test.ts](/Users/chfields/Personal/reevo-run/src/providers/auth/subject.test.ts)
- Added: [src/providers/auth/subject.ts](/Users/chfields/Personal/reevo-run/src/providers/auth/subject.ts)
- Edited: [src/providers/datastore/postgres.test.ts](/Users/chfields/Personal/reevo-run/src/providers/datastore/postgres.test.ts)
- Edited: [src/providers/datastore/postgres.ts](/Users/chfields/Personal/reevo-run/src/providers/datastore/postgres.ts)
- Added: [src/sandbox/bounded-json.ts](/Users/chfields/Personal/reevo-run/src/sandbox/bounded-json.ts)
- Edited: [src/sandbox/bridge.ts](/Users/chfields/Personal/reevo-run/src/sandbox/bridge.ts)
- Edited: [src/sandbox/eval-core.ts](/Users/chfields/Personal/reevo-run/src/sandbox/eval-core.ts)
- Edited: [src/sandbox/fetch-policy.ts](/Users/chfields/Personal/reevo-run/src/sandbox/fetch-policy.ts)
- Edited: [src/sandbox/host-functions.test.ts](/Users/chfields/Personal/reevo-run/src/sandbox/host-functions.test.ts)
- Edited: [src/sandbox/host-functions.ts](/Users/chfields/Personal/reevo-run/src/sandbox/host-functions.ts)
- Edited: [src/sandbox/limits.ts](/Users/chfields/Personal/reevo-run/src/sandbox/limits.ts)
- Edited: [src/sandbox/run-in-sandbox.ts](/Users/chfields/Personal/reevo-run/src/sandbox/run-in-sandbox.ts)
- Added: [src/sandbox/safe-fetch.test.ts](/Users/chfields/Personal/reevo-run/src/sandbox/safe-fetch.test.ts)
- Added: [src/sandbox/safe-fetch.ts](/Users/chfields/Personal/reevo-run/src/sandbox/safe-fetch.ts)
- Edited: [vitest.config.ts](/Users/chfields/Personal/reevo-run/vitest.config.ts)
- Edited: [vitest.contract.config.ts](/Users/chfields/Personal/reevo-run/vitest.contract.config.ts)
