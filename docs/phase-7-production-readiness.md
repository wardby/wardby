# Phase 7: Production Readiness and Operational Hardening

Date: 2026-09-06

Status: Proposed

## Objective

Move the verified security-remediation release candidate into production with
repeatable deployment, recovery, monitoring, and supply-chain controls. Phase 7
does not reopen closed code findings; it proves that the production environment
preserves the boundaries already implemented and tested.

Source documents:

- [Security deployment and recovery](security-deployment.md)
- [Security review issue register](security-review-2026-09-06.md)
- [Security remediation results](security-remediation-results-2026-09-06.md)

## Starting State

- Commit `72dfd41` enables the secured self-hosted OAuth implementation.
- The dedicated GitHub `Security checks` workflow passes migrations, typecheck,
  all tests with Chromium, build, allocation checks, dependency inventory, and
  the time-bounded dependency audit policy.
- The separate `test` workflow is red because it does not install Playwright's
  Chromium binary before running the browser test.
- GitHub Dependabot alerts, code scanning, and secret scanning are disabled.
- SR-009 is accepted only for trusted build and migration tooling through
  2026-10-06. The affected packages are excluded from the runtime image.
- Production migration, TLS/proxy behavior, network policy, database controls,
  secret injection, monitoring, backup, and recovery have not been verified in
  the target environment.

## Delivery Order

1. Make repository checks authoritative and enable continuous security scanning.
2. Build and verify the production infrastructure boundary.
3. Rehearse database migration, credential reissuance, backup, and recovery.
4. Validate the complete HTTPS application flow in staging.
5. Establish monitoring, incident response, and operational ownership.
6. Perform a reviewed canary release and record the production evidence.

## Workstream 1: CI and Repository Protection

Implementation:

1. Fix `.github/workflows/test.yml` by installing the Playwright browser before
   `npm test`, or consolidate it with the authoritative security workflow so the
   same suite is not maintained twice.
2. Require typecheck, full database-backed tests, browser OAuth tests, build,
   migration replay, allocation checks, and the dependency policy on pull requests.
3. Protect `main` from direct unreviewed changes and require current green checks
   before merge.
4. Enable Dependabot alerts and supported dependency update automation.
5. Enable CodeQL or an equivalent code-scanning workflow for JavaScript/TypeScript.
6. Enable secret scanning and push protection where the repository plan supports it.
7. Pin third-party GitHub Actions to reviewed immutable commit SHAs and schedule
   periodic updates.
8. Retain the dependency tree and an SBOM as release artifacts.

Acceptance gate:

- Every required workflow is green on the exact release commit.
- A deliberately failing test blocks a rehearsal pull request.
- New dependency, code-scanning, and secret-scanning alerts are visible and have
  an assigned response owner.
- No duplicate workflow can remain red without blocking or being removed.

## Workstream 2: Production Network and Runtime Boundary

Implementation:

1. Terminate TLS at a reviewed reverse proxy or load balancer and redirect HTTP
   to HTTPS.
2. Overwrite `Host` with the exact canonical host and block direct access to the
   application port.
3. Set `MCP_CANONICAL_URI` and `AUTH_AUDIENCE` to the same normalized HTTPS URL.
4. Permit only required browser origins; do not use wildcard origins.
5. Deny container or VPC egress to metadata, loopback, link-local, and private
   networks unless an exact destination is intentionally approved.
6. Apply connection, request-rate, and body-size limits at the edge in addition
   to the application limits.
7. Run the application as a non-root user from the runtime image. Keep Prisma
   CLI, `@prisma/config`, compilers, package managers, and migration tooling out
   of that image.
8. Verify container filesystem, Linux capabilities, and network permissions are
   no broader than required.

Acceptance gate:

- HTTPS cookies are `Secure`, `HttpOnly`, correctly prefixed, and scoped to `/`.
- Missing, duplicate, malformed, or noncanonical Host requests are rejected.
- Direct application-port ingress is unreachable outside the trusted network.
- Public-to-private redirects, DNS rebinding attempts, and metadata requests fail
  at both the application and network layers.
- Runtime image inspection and audit show none of the SR-009 tooling packages.

## Workstream 3: Database Migration and Recovery

Implementation:

1. Create a production backup and prove it can be restored into an isolated
   environment before applying migrations.
2. Run `prisma migrate deploy` from the separate trusted migration image or job,
   never from a request-serving runtime container.
3. Use an application database role with least privilege and encrypted transport.
4. Configure bounded pools plus short statement, lock, and idle transaction
   timeouts appropriate to production workloads.
5. Verify migration `20260906040000_secure_self_hosted_oauth` preserves unrelated
   data and invalidates every legacy OAuth credential.
6. Re-provision self-hosted users and require all clients to register again as
   public S256 PKCE clients.
7. Rehearse the documented safe recovery path without restoring plaintext legacy
   OAuth credentials.
8. Record backup location, retention, restore owner, recovery point objective,
   and recovery time objective.

Acceptance gate:

- Empty-database migration and production-copy migration both succeed.
- Schema drift is empty after migration.
- Representative unrelated data survives and no legacy bearer-equivalent value
  is usable.
- A timed restore and forward-remigration rehearsal meets the agreed recovery
  objectives.
- The migration and rollback commands are reviewed and stored in the runbook.

## Workstream 4: Secrets and Authentication Operations

Implementation:

1. Generate independent 32-byte values for `AUTH_SIGNING_KEY`,
   `AUTH_CREDENTIAL_HASH_KEY`, and `SECRET_APP_KEY` in the production secret
   manager.
2. Inject secrets at runtime without baking them into images, manifests, CI logs,
   shell history, or repository files.
3. Define owners and procedures for key rotation, global credential reset,
   compromised login keys, user disablement, and refresh-family revocation.
4. Distribute one-time login keys through an approved out-of-band channel.
5. Restrict production CLI and migration access to named operators with audited
   authentication.
6. Verify application, proxy, database, and platform logs do not contain bearer
   tokens, login keys, authorization codes, refresh tokens, webhook secrets,
   request bodies, or fetched response bodies.

Acceptance gate:

- Secret scanning of release artifacts and deployment manifests finds no secrets.
- A login-key revoke, user disable, refresh replay, logout, and planned key-reset
  drill produce the expected invalidation behavior.
- Operator access and emergency procedures are documented and reviewed.

## Workstream 5: Observability and Incident Response

Implementation:

1. Add service health, request latency, error rate, memory, CPU, database pool,
   and sandbox execution metrics.
2. Alert on repeated authentication failures, 403 and 413 spikes, blocked fetch
   destinations, OAuth cleanup failures, database timeout/pool saturation, and
   sustained memory pressure.
3. Correlate sanitized request and run identifiers without logging credentials or
   sensitive payloads.
4. Define service-level objectives and page thresholds for the production owner.
5. Write incident runbooks for credential compromise, SSRF attempts, denial of
   service, database outage, failed migration, and dependency disclosure.
6. Test alert delivery and conduct one tabletop incident exercise before launch.

Acceptance gate:

- Dashboards and alerts work against staging-generated events.
- Every page has an owner, severity, response expectation, and runbook link.
- Logs support incident reconstruction without exposing credentials.

## Workstream 6: Dependency and Supply-Chain Lifecycle

Implementation:

1. Keep `scripts/security-audit.mjs` as the required audit entry point while the
   exception is active. Do not replace it with `npm audit || true`.
2. Recheck Prisma and GHSA-ggr8-5vv4-36mx before 2026-10-06.
3. Remove the exception when a compatible fix is available, or complete a
   separately reviewed Prisma major-version migration.
4. Fail CI immediately for any advisory outside the exact accepted SR-009 chain.
5. Review lockfile changes, package lifecycle scripts, SBOM differences, and
   runtime image contents for every release.
6. Define a recurring dependency review cadence and an owner for expiring risk
   acceptances.

Acceptance gate:

- No unaccepted critical, high, or moderate advisory reaches the runtime image.
- SR-009 is resolved or explicitly reassessed before its expiration; expiration
  automatically fails CI if no new decision is recorded.
- Release artifacts include a dependency inventory and SBOM tied to the commit.

## Workstream 7: Staging and Abuse Validation

Implementation:

1. Deploy the exact production images and configuration shape to staging.
2. Run the complete HTTPS self-hosted OAuth flow: provision, login, consent, code
   exchange, authenticated MCP call, refresh, replay rejection, revoke, and logout.
3. Repeat delegated OAuth and stdio smoke tests.
4. Exercise malformed hosts and origins, oversized fixed and chunked bodies,
   incomplete requests, login throttling, client-capacity limits, SSRF redirects,
   DNS rebinding, sandbox timeouts, and concurrent refresh attempts.
5. Run representative load and soak tests with bounded concurrency while watching
   application memory, database pools, and edge limits.
6. Confirm sanitized error responses and logs under all failure cases.

Acceptance gate:

- Staging passes the security regression suite through the real proxy and network.
- Load and soak tests stay within agreed resource and latency budgets.
- No test is skipped because a browser, database, network policy, or secret is
  unavailable.

## Workstream 8: Launch and Post-Launch Verification

Implementation:

1. Hold a go/no-go review with links to every Phase 7 acceptance artifact.
2. Deploy a canary with an explicit rollback threshold and named decision owner.
3. Verify migrations, health, authentication, MCP operations, alerts, and logs
   immediately after deployment.
4. Expand traffic gradually while monitoring error, latency, memory, and database
   saturation signals.
5. Complete a post-launch review and capture follow-up work without weakening the
   release controls.

Acceptance gate:

- The release commit, images, SBOM, migration, configuration, and evidence are
  traceable as one production release.
- Canary and rollback criteria are tested and approved.
- Production smoke tests pass and monitoring remains healthy through the agreed
  observation window.

## Phase 7 Completion Checklist

- [ ] All required CI workflows pass on the release commit.
- [ ] Dependabot, code scanning, and secret scanning are enabled and triaged.
- [ ] Branch protection requires reviewed changes and current green checks.
- [ ] Runtime and migration images are separated and independently verified.
- [ ] TLS, canonical Host, origin, direct-ingress, and egress controls are proven.
- [ ] Least-privilege encrypted database access and timeouts are configured.
- [ ] Production backup, migration, restore, and safe recovery are rehearsed.
- [ ] Legacy OAuth credentials are invalidated and users/clients are re-provisioned.
- [ ] Production secrets are independently generated, protected, and rotation-tested.
- [ ] Metrics, alerts, sanitized logs, and incident runbooks are operational.
- [ ] SR-009 is resolved or reassessed before 2026-10-06.
- [ ] Full HTTPS staging, abuse, load, and soak validation passes without skips.
- [ ] Canary, rollback, and post-deployment verification are approved.

Production go-live is blocked until every checklist item has linked evidence and
an accountable owner. A risk acceptance must name its scope, owner, compensating
controls, and expiration; it cannot silently convert a failed check into a pass.
