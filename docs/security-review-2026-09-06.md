# Security Review Issue Register

Date: 2026-09-06

Original review scope: static review of the MCP HTTP transport, self-hosted and delegating OAuth providers, authorization boundaries, webhook ingress, sandbox host bridge, secrets storage, persistence, and production dependency tree. No application code was changed during that original review. Implementation results below supersede the original status, not its historical evidence.

## Summary

The original self-hosted OAuth path was removed and replaced. The secured implementation passed its database, browser, HTTP, migration, and review gates, and the owner approved re-enablement on 2026-09-06. Deployment controls and the production migration remain operator responsibilities.

Statuses below were updated only after the corresponding acceptance checks passed. Closed means the code-level finding and applicable release review are addressed, not that production deployment controls have been signed off. See [implementation results](security-remediation-results-2026-09-06.md) and [deployment requirements](security-deployment.md).

| ID | Severity | Status | Area | Issue |
| --- | --- | --- | --- | --- |
| SR-001 | Critical | Closed (release gate) | Self-hosted OAuth | Unauthenticated caller controls the token subject |
| SR-002 | High | Closed (release gate) | Self-hosted OAuth | Authorization codes can be redeemed repeatedly |
| SR-003 | High | Closed (release gate) | Self-hosted OAuth | Confidential clients are not authenticated at the token endpoint |
| SR-004 | High | Closed (local code gate) | Sandbox networking | Redirects and DNS rebinding can bypass the SSRF destination check |
| SR-005 | High | Closed (local code gate) | Availability | HTTP and sandbox bridge payloads can exhaust host memory |
| SR-006 | Medium | Closed (local code gate) | MCP authorization | `list_tools(agentId)` exposes another tenant's attached tool source |
| SR-007 | Medium | Closed (local code gate) | Identity | Tokens without a non-empty `sub` collapse into one principal |
| SR-008 | Medium | Closed (release gate) | OAuth token storage | Client and refresh credentials are stored in plaintext and refresh tokens are reusable |
| SR-009 | Low | Accepted risk through 2026-10-06 | Dependencies | Prisma CLI tree contains a high-severity development-time advisory |
| SR-010 | Medium | Closed (local code gate) | HTTP transport | Requests do not validate the `Host` header |

## Findings

### SR-001: Unauthenticated caller controls the token subject

Severity: Critical

Evidence: `src/mcp/transport/streamable-http.ts:106-116` exposes `GET /authorize` without authenticating a resource owner and copies the query-string `subject` into `handleAuthorize`. `src/providers/auth/self-hosted.ts:177-192` signs that subject into the authorization code, and `src/providers/auth/self-hosted.ts:244-252` signs it into the access token.

Impact: Anyone who can reach self-hosted HTTP mode can select an existing principal subject, request all supported scopes, complete PKCE, and act as that principal. This bypasses every downstream ownership check, including access to agents, tool source, run output, datastores, and secret-management operations.

Recommendation: Remove `subject` from client-controlled authorization parameters. Gate authorization behind a real authenticated user session and explicit consent, then derive the subject and approved scopes server-side. Until that exists, fail startup for `AUTH_PROVIDER=self-hosted` on non-loopback binds or disable the self-hosted authorization endpoints.

Verification: An unauthenticated request cannot obtain a code; changing any query parameter cannot change the authenticated subject; requested scopes are intersected with server-approved scopes.

### SR-002: Authorization codes can be redeemed repeatedly

Severity: High

Evidence: `src/providers/auth/self-hosted.ts:186-192` creates a stateless signed JWT authorization code without a persisted identifier. `src/providers/auth/self-hosted.ts:204-224` validates it but never records or atomically consumes it.

Impact: A captured code and verifier can be replayed for its full lifetime. Every redemption creates a fresh access token and 30-day refresh token, extending the value of a short-lived code and making incident containment difficult.

Recommendation: Store a cryptographic hash of a random, opaque authorization code with its client, redirect URI, PKCE challenge, subject, scopes, expiry, and consumed state. Redeem it using an atomic consume operation. If signed codes are retained, persist and atomically consume a unique `jti`.

Verification: The first redemption succeeds and every concurrent or subsequent redemption of the same code fails.

### SR-003: Confidential clients are not authenticated at the token endpoint

Severity: High

Evidence: Registration advertises and stores `client_secret_post` in `src/providers/auth/self-hosted.ts:139-153`. The HTTP token route reads only `client_id` in `src/mcp/transport/streamable-http.ts:128-142`, and both grant handlers validate only the client ID in `src/providers/auth/self-hosted.ts:213-223` and `src/providers/auth/self-hosted.ts:226-241`.

Impact: A client registered as confidential receives no protection from its client secret. Anyone possessing an authorization code plus verifier or a refresh token can redeem it by supplying only the public client ID.

Recommendation: Load the registered client at the token endpoint, enforce its configured authentication method, and compare a hashed client secret in constant time. Alternatively, support public PKCE clients only and remove `client_secret_post` from metadata and registration.

Verification: Missing, incorrect, duplicated, or incorrectly transported credentials fail for confidential clients; public clients continue to use PKCE without a secret.

### SR-004: Redirects and DNS rebinding can bypass the SSRF destination check

Severity: High

Evidence: `src/sandbox/host-functions.ts:66-76` checks the supplied URL once, then calls `fetch` with its default redirect-following behavior. Redirect destinations are not revalidated. In addition, `src/sandbox/fetch-policy.ts:92-105` performs a DNS lookup for validation, while `fetch` performs a separate lookup when connecting.

Impact: Tool code can request an allowed public endpoint that redirects to loopback, private networks, or cloud metadata. A hostname whose DNS answer changes between validation and connection can produce the same bypass. This can expose internal services or instance credentials to sandboxed tools.

Recommendation: Use `redirect: "manual"`, resolve each redirect against the previous URL, and reapply policy before every hop with a strict hop limit. Bind the validated address to the actual connection through a controlled dispatcher/resolver, or enforce egress policy outside the process at the network layer. Restrict schemes to HTTP and HTTPS.

Verification: Public-to-private redirects, redirect chains, alternate IP encodings, and DNS rebinding simulations are blocked; ordinary public redirects still work within the hop limit.

### SR-005: HTTP and sandbox bridge payloads can exhaust host memory

Severity: High

Evidence: `src/mcp/transport/streamable-http.ts:51-55` buffers request bodies without a byte limit and is used by unauthenticated registration, token, and webhook routes. `src/sandbox/host-functions.ts:71-89` buffers an entire response outside QuickJS before base64 encoding it. `src/sandbox/host-functions.ts:61-64` also accepts an unconstrained random-byte length. QuickJS's 32 MiB limit does not cover these Node-side allocations.

Impact: A remote unauthenticated caller can consume arbitrary host memory with a large or endless request body. Authorized or compromised tool code can do the same using a large fetch response or `randomBytes`, potentially terminating the service and concurrent runs.

Recommendation: Enforce route-specific request limits while streaming, reject oversized `Content-Length` early, abort on overflow, cap fetched response bytes while streaming, and cap all bridge arguments and results. Add server request/header/keep-alive timeouts and deployment-level connection/rate limits.

Verification: Chunked and fixed-length oversized bodies receive `413`; oversized fetch responses and random-byte requests fail without material process-memory growth.

### SR-006: `list_tools(agentId)` exposes another tenant's attached tool source

Severity: Medium

Evidence: `src/mcp/tools/tools.ts:124-134` queries `agentTool` by an arbitrary agent ID and returns complete tool rows without calling `requireReadableAgent` or filtering tools through `visibleToPrincipal`.

Impact: A caller with `tools:write` who learns or guesses another agent ID can retrieve its attached tools, including source code, parameter schema, and descriptions. This crosses the ownership boundary used by the other MCP read paths.

Recommendation: Require read access to the requested agent and filter returned tools by caller visibility. Consider returning a public tool projection without source unless the caller owns the tool.

Verification: Listing tools for another principal's private agent returns not found and does not reveal whether the ID exists.

### SR-007: Tokens without a non-empty `sub` collapse into one principal

Severity: Medium

Evidence: Both `src/providers/auth/delegating.ts:43-54` and `src/providers/auth/self-hosted.ts:274-285` convert a missing subject to the empty string. `src/mcp/auth/principal.ts:9-14` then upserts principals by that value.

Impact: Distinct valid tokens lacking `sub` share the same principal and therefore the same owned resources. This is especially plausible with machine/client-credentials tokens or a misconfigured external issuer.

Recommendation: Reject tokens unless `sub` is a non-empty string. If machine identities are supported, derive an explicitly namespaced principal from a validated client identifier and issuer. Namespace all external subjects by issuer to prevent collisions if multiple issuers are introduced.

Verification: Missing, empty, non-string, and whitespace-only subjects are rejected before any principal lookup or creation.

### SR-008: OAuth credentials are stored in plaintext and refresh tokens are reusable

Severity: Medium

Evidence: `prisma/schema.prisma:241-255` stores `clientSecret` and `refreshToken` directly. `src/providers/auth/self-hosted.ts:226-263` looks up refresh tokens by plaintext value and issues a new refresh token without revoking or rotating the old grant.

Impact: A database read compromise immediately yields usable long-lived credentials. A stolen refresh token remains usable until expiry even after it has been exchanged, increasing replay and persistence risk.

Recommendation: Store keyed hashes of client secrets and refresh tokens, show plaintext only once, rotate refresh tokens on every use, and atomically revoke the token family on reuse. Add explicit grant revocation and cleanup of expired grants.

Verification: Database rows do not contain bearer-equivalent values; refresh-token reuse revokes the family; concurrent refresh attempts yield only one success.

### SR-009: Prisma CLI tree contains a development-time advisory

Severity: Low for deployed runtime; upstream severity: High

Evidence: `npm audit --omit=dev` on 2026-09-06 reported GHSA-ggr8-5vv4-36mx (`deepmerge-ts` stack exhaustion) through `@prisma/config` and the direct `prisma` development dependency. The affected packages are in the Prisma CLI/config tree, not the reviewed runtime path.

Impact: Malicious recursive configuration input could exhaust the stack in affected tooling. Current exposure appears limited to trusted build, generation, and migration workflows, so the project-level severity is reduced.

Recommendation: Track the upstream Prisma resolution and update to a non-vulnerable supported release. Do not blindly apply the audit-suggested downgrade without checking Prisma client/CLI compatibility. Keep production images free of development dependencies and the Prisma CLI where migrations are performed separately.

Verification: `npm audit` no longer reports GHSA-ggr8-5vv4-36mx in the installed build/migration toolchain, and production artifacts contain neither `prisma` nor `@prisma/config` unless operationally required.

Risk decision: The owner accepted the tooling-only exposure on 2026-09-06 through 2026-10-06. CI permits only this advisory's exact `@prisma/config`, `deepmerge-ts`, and `prisma` chain and fails for any other advisory or after expiration. Runtime images remain free of the affected packages.

### SR-010: Requests do not validate the `Host` header

Severity: Medium

Evidence: `src/mcp/transport/streamable-http.ts:64-68` installs only `localhostOriginValidation`. The MCP Node adapter documents `hostHeaderValidation` as a separate guard, and its origin guard intentionally allows requests with no `Origin` header. `toNodeHandler` then constructs its web request URL from the caller-controlled `Host` header.

Impact: A browser or non-browser client can reach the service with an unapproved host value when no `Origin` is present. This weakens DNS-rebinding protection and can create host-confusion bugs as URL-dependent behavior is added. The current localhost-only origin policy is also inconsistent with the documented remote HTTP deployment.

Recommendation: Validate `Host` against the hostname and optional port of `MCP_CANONICAL_URI` before routing. Configure a separate explicit origin allowlist for browser clients. If a reverse proxy is used, make it normalize `Host` and block direct access to the application port rather than trusting forwarded headers from arbitrary peers.

Verification: Missing, malformed, and unapproved hosts receive `403`; the canonical host succeeds; requests without `Origin` still cannot bypass host validation.

## Positive Controls Observed

- Delegating OAuth verifies JWT signature, issuer, audience, and expiry through `jose`.
- MCP mutation paths generally enforce both scopes and ownership.
- User-managed secrets use AES-256-GCM with per-value random IVs and authenticated decryption.
- Webhook secrets are randomly generated, stored as hashes, and compared in constant time.
- QuickJS execution has heap, stack, instruction, wall-time, and fetch-time limits.
- Sandbox destination policy blocks common private, loopback, link-local, and metadata ranges for the initially supplied URL.
- No committed environment files, private keys, or obvious live credentials were found by the repository scan.

## Review Limits

This was a source review, not a penetration test. It did not assess reverse-proxy configuration, TLS termination, database/network ACLs, container hardening, cloud IAM, CI/CD permissions, or a deployed instance. Dependency results are a point-in-time npm advisory snapshot.

## Implementation Evidence (2026-09-06)

| Finding | Evidence and remaining gate |
| --- | --- |
| SR-001 | [Secure provider](../src/providers/auth/self-hosted.ts), [sessions](../src/mcp/auth/self-hosted/session.ts), [browser flow](../src/mcp/auth/self-hosted/browser.test.ts), and [database regressions](../src/providers/auth/self-hosted.test.ts): provisioned identity, single-use CSRF, consent, and rejected subject substitution. Release review passed. |
| SR-002 | Opaque hashed codes, expiry and binding checks, atomic consumption; eight concurrent exchanges produce one success in the database tests. Release review passed. |
| SR-003 | Only public clients and S256 PKCE are supported; confidential registration is rejected and no client secret is generated. Release review passed. |
| SR-004 | [Safe fetch](../src/sandbox/safe-fetch.ts) and [41 regressions](../src/sandbox/safe-fetch.test.ts): special address classes, redirects, mixed DNS answers, pinned lookup, stripped credentials, cancellation, and response limits. |
| SR-005 | [HTTP limits](../src/mcp/transport/http-security.test.ts), [host bridge regressions](../src/sandbox/host-functions.test.ts), database value guards, and [allocation check](../scripts/security-allocation-check.mjs) pass. Endless response stops after 8.125 MiB with 9.47 MiB observed peak RSS growth. Database cancellation and whole-process concurrency remain explicit deployment/architecture caveats, not guarantees of the allocation fix. |
| SR-006 | [Ownership regressions](../src/mcp/tools/tools.test.ts) prove private-agent anti-enumeration and metadata-only public/non-owner projections. |
| SR-007 | [Subject regressions](../src/providers/auth/subject.test.ts) and signed delegated-token tests reject missing, malformed, blank, and oversized subjects before principal creation. |
| SR-008 | HMAC credential storage, rotating refresh families, reuse revocation, key/user revocation, and [migration recovery rehearsal](../scripts/security-migration-rehearsal.mjs) pass. Release review passed; production migration is still required before deployment. |
| SR-009 | Raw repository audits report three affected tooling packages for one advisory. The owner accepted the isolated build/migration-tooling risk through 2026-10-06. The runtime image excludes the affected tooling and its shipped-subset audit reports zero vulnerabilities. |
| SR-010 | Exact canonical Host plus explicit Origin checks, malformed/missing/duplicate Host rejection, and delegated metadata tests pass. |

Candidate verification: 400/400 full tests, 115/115 focused tests, 2/2 live
contract tests, typecheck, build, Prisma validation, all nine migrations, empty
schema drift, seven recovery assertions, and four allocation assertions passed.
After removing two quarantine-only assertions, release verification passed all
398 current tests across 51 files, typecheck, build, and the audit policy. No
tests were skipped. Raw repository audits still report SR-009; the time-bounded
policy accepts only that exact chain. The remediation was committed as `dca4648`.
No production migration or deployment was performed.
