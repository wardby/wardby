# Security Remediation Implementation Plan

Date: 2026-09-06

Status: Code and release gates complete; SR-009 accepted through 2026-10-06; deployment gates remain open

Source: `docs/security-review-2026-09-06.md`

## Objective

Close SR-001 through SR-010 without weakening the existing scope, ownership, budget, or sandbox controls. The work should produce secure defaults, regression tests for every finding, an explicit deployment contract, and a reviewable rollout path.

This plan intentionally separates containment from feature work. The critical self-hosted OAuth path must become unreachable before lower-severity improvements are allowed to delay the release.

## Decisions Required

### D1: Self-hosted OAuth quarantine and re-enable

Decision: preserve self-hosted OAuth, but quarantine its issuance endpoints while they are rebuilt. Delegating OAuth and stdio remain usable during the work. Re-enable self-hosted mode only after the dedicated release gate in Task 2 passes.

Release decision: the secure replacement passed the Task 2, Task 3, and Task 4 gates and was approved for re-enablement on 2026-09-06. The startup quarantine is removed; the deployment checklist remains mandatory.

Identity design:

- A local operator provisions each self-hosted user through a CLI command. The command creates a principal and a high-entropy login key, displays the key once, and stores only a keyed hash.
- A browser submits that key to a same-origin login form. The server rotates into a short-lived, server-side session carried by an `HttpOnly`, `SameSite=Lax`, `Secure` cookie.
- `/authorize` derives the subject only from that authenticated session. It stores an authorization interaction server-side and requires a CSRF-protected consent POST before issuing a code.
- The first secure release supports public OAuth clients with PKCE only. It does not advertise or accept `client_secret_post`. Confidential-client support can be added later with a separate need and review.

Rationale:

- The current server has no resource-owner authentication system, so replacing the query-string `subject` requires a real identity and session boundary.
- Random operator-provisioned keys avoid password hashing, password reset, credential-stuffing, and email-delivery work while supporting multiple principals.
- Public PKCE clients cover the MCP desktop/CLI use case and remove the broken confidential-client branch rather than pretending its client secret is enforced.
- Server-side interactions, opaque one-use codes, and rotating refresh-token families make replay decisions transactional and auditable.

Consequences:

- Existing self-hosted authorization codes, clients, access tokens, and refresh tokens are invalidated during migration and must be reissued.
- Users need a newly provisioned login key. Lost keys are revoked and replaced by an operator; plaintext keys are never recoverable from the database.
- Self-hosted mode requires HTTPS except for explicit loopback development.
- The operator must protect the CLI and distribute login keys through an out-of-band secure channel.

Do not re-enable self-hosted mode with a caller-controlled `subject`, a trusted-header shortcut, a reusable authorization code, plaintext bearer credentials, or a production escape-hatch flag.

### D2: Resource limits

Use fixed conservative defaults first; configuration can be added later if real workloads demonstrate a need.

| Surface                                |       Initial limit |
| -------------------------------------- | ------------------: |
| MCP JSON request                       |               1 MiB |
| Webhook JSON request                   |               1 MiB |
| OAuth login/registration/token request |              64 KiB |
| Sandbox fetch response                 | 8 MiB decoded bytes |
| Sandbox `randomBytes` request          |              64 KiB |
| Redirect hops                          |                   5 |
| Request completion                     |          15 seconds |
| Request headers                        |          10 seconds |

Limit failures must be explicit and must not include request bodies, bearer tokens, webhook secrets, or fetched response content in logs.

### D3: Tool-source visibility

Treat tool source and parameter schemas as private implementation data. `list_tools(agentId)` may return full rows only when the caller can read the agent and can read each tool. A future public catalog should use a separate metadata-only projection.

## Delivery Order

1. Quarantine self-hosted OAuth issuance with Task 1.
2. Harden identity validation and HTTP request boundaries with Tasks 3 and 4.
3. Rebuild and re-enable self-hosted OAuth with Task 2; its release gate depends on Tasks 3 and 4.
4. Replace the sandbox fetch path and cap all host-side allocations with Tasks 5 and 6.
5. Close the `list_tools` ownership gap with Task 7.
6. Resolve the dependency advisory and production packaging with Task 8.
7. Run the complete verification and rollout gates with Task 9.

Each task below should be its own reviewable commit unless a schema migration and its application changes must remain atomic.

## Task 1: Contain Self-Hosted OAuth Immediately

Findings: SR-001, SR-002, SR-003, SR-008

Files:

- Modify `src/mcp/index.ts`
- Modify `src/config/providers.ts`
- Modify `.env.example`
- Modify `README.md`
- Test `src/mcp/integration.test.ts`
- Test `src/mcp/transport/streamable-http.test.ts`

Implementation:

1. Reject `AUTH_PROVIDER=self-hosted` during production startup with an actionable error explaining that issuance is quarantined until the secure implementation is complete.
2. Keep the provider callable only from unit and integration tests while it is being replaced; do not add an environment bypass that can expose the old routes.
3. Stop mounting authorization-server metadata, registration, authorization, and token routes in the quarantined build.
4. Keep self-hosted configuration documented as temporarily unavailable rather than deleting it.
5. Warn that existing self-hosted credentials will be invalidated by the secure migration.
6. Validate at startup that `MCP_CANONICAL_URI` and `AUTH_AUDIENCE` are identical normalized URLs.
7. Require HTTPS canonical URLs except for loopback development and test servers.

Tests first:

- HTTP startup with `AUTH_PROVIDER=self-hosted` fails before listening on a socket.
- `/authorize`, `/token`, `/register`, and self-hosted metadata return `404` in delegating mode.
- Protected-resource metadata identifies the external authorization server.
- Mismatched canonical URI and audience fail startup.
- Non-loopback HTTP canonical URIs fail startup.

Acceptance gate:

- No unauthenticated route can issue a reevo bearer token.
- Remote MCP remains usable with a valid delegated token.
- Stdio behavior is unchanged.

Suggested commit: `fix(auth): quarantine unsafe self-hosted token issuance`

## Task 2: Rebuild and Re-enable Self-Hosted OAuth

Findings: SR-001, SR-002, SR-003, SR-008

Primary files:

- Replace `src/providers/auth/self-hosted.ts`
- Expand `src/providers/auth/self-hosted.test.ts`
- Modify `src/providers/auth/index.ts`
- Split authorization-server types out of `src/providers/auth/types.ts`
- Modify `src/mcp/transport/streamable-http.ts`
- Add `src/mcp/auth/self-hosted/session.ts`
- Add `src/mcp/auth/self-hosted/login.ts`
- Add `src/mcp/auth/self-hosted/consent.ts`
- Add `src/mcp/auth/self-hosted/credentials.ts`
- Add `src/mcp/auth/self-hosted/rate-limit.ts`
- Modify `src/cli.ts`
- Modify `prisma/schema.prisma`
- Add `prisma/migrations/<timestamp>_secure_self_hosted_oauth/migration.sql`
- Add database-backed flow and concurrency tests

### Task 2A: Provision local identities and login keys

Schema:

- `AuthUser`: `id`, unique `principalId`, optional display name, `status`, `createdAt`, `updatedAt`. `Principal.subject` remains the only source of subject identity.
- `AuthLoginKey`: public `keyId`, `userId`, `secretHash`, `createdAt`, `lastUsedAt`, `expiresAt`, `revokedAt`.
- `AuthSession`: public `sessionId`, `userId`, `secretHash`, `createdAt`, `lastSeenAt`, `expiresAt`, `revokedAt`.
- `AuthFormChallenge`: public `challengeId`, optional `sessionId`, `purpose`, `secretHash`, `createdAt`, `expiresAt`, `consumedAt`.

Implementation:

1. Add `reevo auth user create --subject <subject>` and `reevo auth user list`. Creation resolves one `Principal`, then links one `AuthUser` to it.
2. Add `reevo auth key create --subject <subject>`, `reevo auth key list --subject <subject>`, and `reevo auth key revoke <key-id>`.
3. Generate login keys as an identifier plus 32 random bytes, for example `rvk_<keyId>.<secret>`. Display the complete value exactly once.
4. Hash credential secrets with HMAC-SHA-256 using a dedicated 32-byte `AUTH_CREDENTIAL_HASH_KEY`. Do not reuse the JWT signing key or `SECRET_APP_KEY`.
5. Look up by the public identifier, compute the keyed hash, and compare fixed-size values in constant time.
6. Add a disabled user state that immediately blocks login and revokes all sessions and login keys.
7. Never accept a subject during browser login; the stored login-key row determines the user and subject.

Tests first:

- Provisioning prints a login key once and stores no plaintext equivalent.
- Valid keys resolve the expected user; altered, expired, revoked, or disabled-user keys fail.
- Repeated failures do not reveal whether a key ID or user exists.

### Task 2B: Establish secure browser sessions

Implementation:

1. Add `GET /login` and `POST /login`. The GET creates a short-lived login challenge and renders a minimal same-origin form; the POST accepts the login key in the body.
2. Protect login submission with a random, single-use `AuthFormChallenge` bound to a temporary `HttpOnly`, `SameSite=Strict` cookie and hidden form field.
3. On success, rotate to a random session token, store only its keyed hash, and set an `HttpOnly`, `SameSite=Lax`, `Secure`, `Path=/` cookie. Use the `__Host-` prefix in HTTPS deployments.
4. Use a 12-hour idle lifetime and 30-day absolute lifetime. Rotate the session token on login and privilege-sensitive transitions.
5. Protect consent and logout forms with purpose-bound, short-lived, single-use `AuthFormChallenge` rows tied to the authenticated session.
6. Add `POST /logout` with CSRF protection and server-side revocation.
7. Set `Cache-Control: no-store`, a restrictive Content Security Policy, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer` on login and consent pages.
8. Apply per-IP and per-key-ID login throttles through a `RateLimiter` interface. The production implementation must use shared persistence when more than one reevo process serves traffic.

Tests first:

- Session cookies have the required attributes and rotate after login.
- Session lookup rejects altered, expired, revoked, disabled-user, and idle sessions.
- Login CSRF and session fixation attempts fail.
- Logout revokes the database row before clearing the cookie.

### Task 2C: Create server-side authorization interactions and consent

Schema:

- `OAuthAuthorizationRequest`: `id`, `clientId`, `redirectUri`, `resource`, `requestedScope`, `codeChallenge`, `state`, `createdAt`, `expiresAt`, `consumedAt`.
- `OAuthAuthorizationCode`: `codeId`, `secretHash`, `clientId`, `userId`, `redirectUri`, `resource`, `scope`, `codeChallenge`, `createdAt`, `expiresAt`, `consumedAt`.

Implementation:

1. Validate `/authorize` parameters, then persist a short-lived interaction instead of signing the request into a JWT code.
2. Remove `subject` from `AuthorizeParams` and ignore/reject any incoming `subject` parameter.
3. If there is no valid session, redirect to `/login` with only the opaque interaction ID. After login, continue to `/consent`.
4. Render the client name, exact scopes, and resource on the consent page. Approve or deny only through a CSRF-protected POST.
5. Intersect requested scopes with `SCOPES_SUPPORTED` and any per-user policy. Never issue unknown or unapproved scopes.
6. On approval, generate an opaque authorization code containing a public ID and 32 random secret bytes. Store only its keyed hash.
7. Bind the code to the client ID, exact redirect URI, resource, user, approved scope, and S256 PKCE challenge.
8. Expire interactions after 10 minutes and codes after 60 seconds. Mark denied or completed interactions consumed.
9. Redeem a code in one transaction using an atomic update whose predicate includes `consumedAt IS NULL` and `expiresAt > now()`. Exactly one concurrent caller may succeed.
10. Preserve and return OAuth `state` without logging it. Return authorization errors through the validated redirect URI when safe; never redirect to an unvalidated URI.

Tests first:

- Unauthenticated authorization reaches login and cannot issue a code.
- The authenticated session is the only source of subject identity.
- Consent denial issues no code; approval grants only displayed supported scopes.
- Query-string subject substitution has no effect.
- First code redemption succeeds; sequential and concurrent replay fail.
- Client, redirect URI, resource, expiry, and PKCE mismatches fail.

### Task 2D: Support public clients safely

Implementation:

1. Advertise only `token_endpoint_auth_methods_supported: ["none"]` in the first re-enabled release.
2. Reject registration requests for `client_secret_post` or any unsupported authentication method.
3. Validate dynamic registration metadata: one to ten redirect URIs, exact URI strings, no fragments or embedded credentials, HTTPS except loopback HTTP, supported grant types only, and bounded client names.
4. Require S256 PKCE for every authorization-code request. Do not support `plain` PKCE.
5. Rate-limit registration and set a deployment-configurable maximum client count.
6. Re-register all clients after migration rather than importing insecure legacy client records.

Tests first:

- Confidential registration is rejected and no secret is generated.
- Invalid redirect forms and unsupported grants are rejected.
- Redirect matching is exact, including scheme, host, port, path, and query.

This resolves SR-003 by removing the unsupported confidential-client promise. If confidential clients are added later, they require hashed secrets and enforced client authentication on both code and refresh grants.

### Task 2E: Rotate hashed refresh tokens

Schema:

- `OAuthGrant`: `id`, `familyId`, `clientId`, `userId`, `scope`, `refreshTokenHash`, `createdAt`, `expiresAt`, `consumedAt`, `revokedAt`, `replacedById`.

Implementation:

1. Generate refresh tokens as a grant ID plus 32 random secret bytes; store only the keyed hash.
2. Rotate on every successful refresh. Consume the old row and insert its replacement in the same transaction.
3. Retain consumed rows until the token family expires. Reuse of any consumed token revokes every grant in that family.
4. Check client, user status, expiry, revocation, and approved scopes during refresh.
5. Add `POST /revoke` for refresh-token and family revocation and a cleanup job for expired interactions, sessions, codes, and grants.
6. Issue short-lived access tokens, initially 10 minutes, containing `iss`, `aud`, `sub`, `scope`, `iat`, `exp`, `jti`, and `client_id`.
7. Validate the signing key as at least 32 decoded random bytes if symmetric signing remains local. Prefer a `SigningKeyProvider` abstraction so asymmetric keys and rotation can be added without changing grant logic.

Tests first:

- Database rows never contain the returned refresh token.
- Refresh produces a replacement and makes the old token unusable.
- Sequential or concurrent old-token reuse revokes the family.
- Revoked, expired, wrong-client, and disabled-user grants fail.
- Access tokens have the complete expected claim set and are accepted only by the configured resource audience.

### Task 2F: Migrate and re-enable

Migration:

1. Take a database backup for unrelated data.
2. Drop and recreate the legacy `OAuthClient` and `OAuthGrant` tables because they contain bearer-equivalent plaintext and incompatible semantics.
3. Create the identity, login-key, session, interaction, code, client, and rotating-grant tables with foreign keys and indexes.
4. Do not export or migrate old plaintext credentials. Document that every client and user credential must be re-provisioned.
5. Rehearse forward migration and full rollback on a disposable copy before production.

Re-enable gate:

- Remove the Task 1 startup quarantine only after all Task 2 database-backed tests and the Task 3 and Task 4 acceptance gates pass.
- Run the HTTP flow through a real browser-capable test client: login, consent, code exchange, MCP call, refresh, replay rejection, revocation, and logout.
- Verify all auth pages and endpoints use the Task 4 host, origin, body, timeout, and secure-header controls.
- Have a second reviewer inspect identity derivation, CSRF, code consumption, token rotation, and migration behavior.
- Update README and `.env.example` with provisioning, HTTPS, key rotation, and recovery procedures.

Result: complete. The implementation and orchestration reviews covered the listed boundaries, all automated gates passed, and the owner approved re-enablement.

Acceptance gate:

- Self-hosted mode starts only with all credential and signing keys present and valid.
- No caller-controlled value chooses the subject.
- No authorization code can succeed twice.
- No database value is directly usable as a login key, authorization code, or refresh token.
- Confidential client authentication is neither advertised nor accepted.
- Existing SR-001, SR-002, SR-003, and SR-008 exploit cases are permanent regression tests.

Suggested commits:

- `feat(auth): add provisioned users and secure sessions`
- `fix(auth): issue atomic one-use authorization codes`
- `fix(auth): rotate hashed refresh token families`
- `feat(auth): re-enable secured self-hosted oauth`

## Task 3: Require a Valid Token Subject

Finding: SR-007

Files:

- Modify `src/providers/auth/delegating.ts`
- Modify `src/providers/auth/delegating.test.ts`
- Modify `src/mcp/auth/principal.ts`
- Modify `src/mcp/auth/principal.test.ts`

Implementation:

1. Add one helper that accepts an unknown JWT `sub` claim and returns a validated subject.
2. Require a string with non-whitespace content. Set a reasonable maximum, such as 512 UTF-8 bytes, before using it as a database key.
3. Reject missing, null, numeric, empty, whitespace-only, and oversized values as authentication failures.
4. Add a defensive assertion in `resolvePrincipal` so no future authentication adapter can create an empty principal.
5. Preserve the subject exactly after validation; do not lowercase or otherwise normalize an issuer-defined identifier.
6. Continue requiring the configured issuer in JWT validation. If support for multiple issuers is added later, migrate `Principal` to a composite `(issuer, subject)` identity before enabling it.

Tests first:

- A normal string subject authenticates and resolves the same principal on repeated requests.
- Every invalid subject form is rejected before a database call.
- Two distinct valid subjects remain isolated.

Acceptance gate:

- There is no `String(payload.sub ?? "")` fallback in an auth provider.

Suggested commit: `fix(auth): reject tokens without a stable subject`

## Task 4: Enforce Host, Origin, and Request Boundaries

Findings: SR-005, SR-010

Files:

- Modify `src/mcp/transport/streamable-http.ts`
- Add `src/mcp/transport/http-limits.ts` if helpers make the transport difficult to audit
- Modify `src/mcp/transport/streamable-http.test.ts`
- Modify `src/config/providers.ts`
- Modify `.env.example`

Implementation:

1. Parse `MCP_CANONICAL_URI` once at startup and derive the only accepted `Host`, including the port when non-default.
2. Apply `hostHeaderValidation` before origin validation and before parsing a body.
3. Replace the hard-coded localhost origin guard with an explicit allowlist. Default to the canonical origin; permit additional origins only through a parsed `MCP_ALLOWED_ORIGINS` list of exact origins.
4. Do not trust `Forwarded` or `X-Forwarded-*` headers in the application. A reverse proxy must normalize `Host`, terminate TLS, and prevent direct access to the app port.
5. Replace unbounded `readBody` with `readBody(req, maxBytes, signal)`. Count raw bytes while streaming, reject an excessive `Content-Length` before reading, abort and drain/destroy safely on overflow, and throw a typed `PayloadTooLargeError`.
6. Read the MCP body through the same bounded helper, parse JSON once, and pass the parsed object as the third argument to `nodeHandler`. This avoids the MCP adapter's own unbounded stream collection.
7. Return `413` for size overflow, `400` for malformed JSON/form bodies, `408` for request timeout, and `415` for unsupported content types.
8. Set `requestTimeout`, `headersTimeout`, `keepAliveTimeout`, and `maxRequestsPerSocket` on the Node server.
9. Send `Cache-Control: no-store` on authentication errors and any remaining token-related responses during transition.
10. Sanitize externally returned errors. Log an internal error identifier rather than returning raw library or database messages.

Tests first:

- Canonical host succeeds; missing, malformed, and unapproved hosts fail with `403`.
- Requests without `Origin` still undergo host validation.
- Exact allowed origins succeed; lookalike origins fail.
- Oversized fixed-length and chunked bodies fail with `413` for MCP and webhook routes.
- A request exactly at the limit succeeds.
- Malformed JSON fails without invoking auth, database, or MCP handlers.
- Slow/incomplete request bodies time out and release the socket.

Acceptance gate:

- No route buffers an unbounded request body.
- Remote deployment behavior is represented by tests, not only loopback behavior.

Suggested commit: `fix(http): validate hosts and bound request bodies`

## Task 5: Replace Sandbox Fetch with a Policy-Enforcing Client

Findings: SR-004, part of SR-005

Files:

- Modify `src/sandbox/fetch-policy.ts`
- Add `src/sandbox/safe-fetch.ts`
- Modify `src/sandbox/host-functions.ts`
- Modify `src/sandbox/fetch-policy.test.ts`
- Add `src/sandbox/safe-fetch.test.ts`
- Modify `src/sandbox/limits.ts`
- Possibly modify `package.json` and `package-lock.json` for an explicit HTTP client/dispatcher dependency

Implementation:

1. Expose one `safeFetch` function; sandbox code must not call global `fetch` directly.
2. Accept only `http:` and `https:` URLs. Reject embedded URL credentials and malformed hosts.
3. Change address policy from a short private-range denylist to a global-unicast allow decision for IPv4 and IPv6. Block loopback, private, link-local, multicast, unspecified, carrier-grade NAT, benchmarking, documentation, reserved, and IPv4-mapped IPv6 forms unless the hostname is explicitly allowlisted.
4. Resolve all addresses for a hostname, reject if any selected destination is disallowed, and pin the validated address to the actual connection through the HTTP client's lookup/dispatcher hook. Do not validate with one DNS lookup and connect with another.
5. Use manual redirect handling. Resolve each `Location` against the previous URL, re-run the complete policy, and stop after five hops.
6. Strip `Authorization`, `Cookie`, `Proxy-Authorization`, and other credential-bearing headers when a redirect changes origin.
7. Stream the response while counting decoded bytes. Abort above 8 MiB before creating a full `Buffer` or base64 copy.
8. Combine fetch timeout and sandbox cancellation with `AbortSignal.any` or equivalent so a timed-out sandbox tears down in-flight host work.
9. Return a stable sandbox error category for blocked destination, timeout, redirect limit, and response-size limit without exposing internal addresses unnecessarily.
10. Treat `REEVO_FETCH_ALLOWED_HOSTS` as exact normalized hostnames. Reject wildcards and empty entries. Document that allowlisting private hosts intentionally bypasses network isolation.

Tests first:

- Initial requests to every blocked address class fail.
- A public endpoint redirecting to loopback, RFC1918, IPv6 local, or metadata fails.
- A mixed public/private DNS answer cannot select the private address.
- A rebinding test proves the connection uses the validated pinned address.
- Cross-origin redirects strip credentials.
- Redirect loops stop at the configured hop limit.
- Oversized responses abort with bounded process-memory growth.
- Normal public requests and same-origin redirects continue to work.

Defense in depth:

- Production deployment should also deny private and metadata egress at the container/VPC/firewall layer. Application checks are required but should not be the only boundary protecting cloud credentials.

Acceptance gate:

- A code search shows no sandbox path calling global `fetch` outside `safe-fetch.ts`.
- Redirect and rebinding regression tests fail against the old implementation and pass against the new one.

Suggested commit: `fix(sandbox): enforce ssrf policy across connections and redirects`

## Task 6: Cap Every Sandbox Host Allocation

Finding: remaining SR-005

Files:

- Modify `src/sandbox/host-functions.ts`
- Modify `src/sandbox/bridge.ts`
- Modify `src/sandbox/limits.ts`
- Modify `src/sandbox/host-functions.test.ts`
- Modify `src/sandbox/run-in-sandbox.test.ts`

Implementation:

1. Validate `randomBytes(length)` as a finite integer from 0 through 65,536 before calling Node crypto.
2. Cap bridge input JSON and serialized result sizes before creating QuickJS strings.
3. Cap parser inputs for HTML, CSV, and XML and reject outputs that exceed the bridge result limit.
4. Restrict XML parser options to an explicit safe subset. Do not accept an arbitrary caller-supplied options object.
5. Tie all host functions to the invocation abort signal. Clear sleep timers and terminate outstanding work when wall time expires.
6. Track and clear the wall-time timer in `evalToJson` so successful calls do not leave timers pending.
7. Avoid logging arbitrary nested tool values without a maximum serialized size. Redact values only by policy; do not claim secrets are protected from logs if tool code explicitly logs them.

Tests first:

- Negative, fractional, infinite, NaN, and oversized random-byte lengths fail.
- Oversized parser and bridge payloads fail before host allocation.
- Timeout aborts sleep and fetch host work.
- Repeated successful invocations do not accumulate active timers or handles.

Acceptance gate:

- QuickJS memory limits are supplemented by explicit limits on every Node-side host bridge.

Suggested commit: `fix(sandbox): cap host bridge inputs and allocations`

## Task 7: Close Tool-Source Authorization Gap

Finding: SR-006

Files:

- Modify `src/mcp/tools/tools.ts`
- Modify `src/mcp/tools/tools.test.ts`
- Modify `src/mcp/auth/ownership.ts` only if a reusable tool visibility helper is needed

Implementation:

1. Call `requireReadableAgent` before querying attachments when `agentId` is provided.
2. Filter attached tools through the same owner/public visibility rule used by unfiltered `list_tools`.
3. Return `404` for a private agent owned by another principal, matching the existing anti-enumeration behavior.
4. Define an explicit response projection. Owners may receive source and schema; public/non-owner readers should receive only `id`, `name`, and `description` unless public source visibility is an intentional product requirement.
5. Keep attach and detach owner checks unchanged.

Tests first:

- An owner can list attached tools and receive the owner projection.
- Another principal receives `404` and no rows for a private agent.
- A readable public agent does not expose private tool source.
- Listing all tools never returns another principal's private tools.

Acceptance gate:

- Every query that accepts an `agentId` performs an agent authorization check before reading related records.

Suggested commit: `fix(mcp): authorize attached tool listings`

## Task 8: Resolve Dependency and Packaging Exposure

Finding: SR-009

Files:

- Modify `package.json` and `package-lock.json` when a supported fixed Prisma release is available
- Add or modify production image/build configuration when deployment packaging exists
- Modify CI configuration when present

Implementation:

1. Check the current Prisma release notes and advisory before changing versions. Keep `prisma` and `@prisma/client` on compatible versions.
2. Do not apply npm's suggested downgrade automatically. Verify schema generation, migration behavior, and client compatibility first.
3. Add separate CI checks for production dependencies and the complete build toolchain.
4. Build runtime artifacts with production dependencies only. Run migrations in a separate trusted job or image if the Prisma CLI is required operationally.
5. Generate an SBOM or at minimum archive `npm ls --all` with release artifacts.

Tests and checks:

- `npm audit --omit=dev`
- `npm audit`
- `npm run prisma:generate`
- Migration against a disposable PostgreSQL database
- Full test and build gates
- Inspection of the production artifact for `prisma`, `@prisma/config`, and `deepmerge-ts`

Acceptance gate:

- GHSA-ggr8-5vv4-36mx is absent from the build toolchain, or a time-bounded exception documents why the vulnerable code is unreachable and when it will be revisited.

Result: the owner accepted the trusted build/migration-tooling exception on 2026-09-06 through 2026-10-06. CI fails for any other advisory and automatically rejects this exception after expiration.

Suggested commit: `chore(deps): update prisma security baseline`

## Task 9: Full Verification and Release Gate

Run after every task-specific test passes.

Required commands:

```sh
npm run typecheck
npm test
npm run test:contract
npm run build
npm audit --omit=dev
```

Database gate:

1. Start a disposable PostgreSQL instance.
2. Apply every migration from an empty database.
3. Seed representative principals, agents, tools, runs, secrets, webhooks, and legacy OAuth rows in a copy of the pre-remediation schema.
4. Apply the new migrations and verify all non-OAuth data survives.
5. Confirm legacy plaintext OAuth credentials are gone and the new credential columns contain hashes only.
6. Run database-backed auth and concurrency tests with `DATABASE_URL` set; skipped tests do not satisfy this gate.

Security regression gate:

- Attempt subject omission and identity substitution.
- Run the complete self-hosted flow and attempt login-key theft, session fixation, CSRF, scope escalation, code replay, refresh replay, and client/redirect substitution.
- Replay oversized fixed-length, chunked, and slow request bodies.
- Exercise public-to-private redirects and DNS rebinding.
- Attempt cross-owner `list_tools(agentId)` access.
- Verify logs contain no bearer token, client credential, webhook secret, request body, or fetched body.

Operational gate:

- Reverse proxy terminates TLS and overwrites `Host`.
- Direct access to the application port is blocked.
- Container/VPC egress blocks metadata and private ranges unless explicitly required.
- Database credentials use least privilege and encrypted transport.
- Secrets and auth keys are supplied by a secret manager, not environment files in the image.
- Alerting covers repeated 401/403/413 responses, blocked fetch destinations, and process memory pressure without logging credentials.

Release acceptance:

- All required checks pass.
- Every finding in the issue register has a linked commit and regression test.
- The issue register status changes only after the corresponding acceptance gate passes.
- A second reviewer inspects auth, migration, and SSRF changes.
- The deployment guide covers both delegated OAuth and the secured self-hosted provisioning, recovery, rotation, and revocation flow.

## Future Self-Hosted Enhancements

These are not required to re-enable the first secure self-hosted release:

- Passkeys or another phishing-resistant second factor.
- Confidential clients with hashed client secrets and enforced client authentication.
- Asymmetric signing keys, JWKS publication, and automated rotation.
- Per-user scope policy and administrator-managed grants.
- A maintained authorization-server library if its protocol and storage abstractions fit the project.
- Formal OAuth conformance testing and an external penetration test.

## Completion Checklist

- [x] Self-hosted token issuance is quarantined before remediation begins.
- [x] Users and login keys can be provisioned, listed, revoked, and disabled through the CLI.
- [x] Login, session, CSRF, and consent flows pass browser-level tests.
- [x] Self-hosted token issuance is re-enabled only after its release gate passes.
- [x] Legacy plaintext OAuth credentials are invalidated and all new credentials are stored as keyed hashes.
- [x] Authorization codes are opaque, short-lived, and atomically single-use.
- [x] Refresh tokens rotate with family reuse detection and revocation.
- [x] Self-hosted mode supports public S256 PKCE clients and rejects confidential registration.
- [x] Delegated tokens require a valid non-empty subject.
- [x] Canonical host and allowed origins are validated.
- [x] Every HTTP request body has a streaming byte limit and timeout.
- [x] Sandbox fetch revalidates redirects and pins validated DNS results.
- [x] Every Node-side sandbox allocation is explicitly capped.
- [x] Attached tool listings enforce agent and tool visibility.
- [x] Dependency advisory is resolved or formally time-bounded.
- [x] Database migration rehearsal passes.
- [x] Full tests, contract tests, build, typecheck, and security audit policy pass.
- [x] Issue-register statuses and deployment documentation are updated.

## Execution Record (2026-09-06)

Implementation followed the delivery order. Source changes and test evidence are
listed in [the completion report](security-remediation-results-2026-09-06.md).
The remediation landed on `main` as `dca4648`; this follow-up records the owner
approval, removes the startup quarantine, and formalizes the SR-009 exception.

All local code, database, browser, migration, build, typecheck, and contract
checks passed. The original full suite had 400 passes and zero failures or skips.
Raw repository audits still report SR-009; the narrow, expiring policy exception
is accepted and the shipped runtime audit is clean.

After removing two quarantine-only assertions, release verification passed all
398 current tests across 51 files with no skips, including the migrated database
and real Chrome OAuth flow. Typecheck, build, and the audit policy also passed.

Release and architecture notes:

- Self-hosted startup is enabled after implementation review, independent orchestration review, automated acceptance checks, and the owner's release decision.
- A full rollback that restores legacy plaintext credentials is unsafe. The tested secure alternative restores unrelated data, recreates empty legacy OAuth placeholders, and reapplies the secure migration without resurrecting credentials.
- Refresh bindings are normalized into an additional OAuthFamily row, which serializes concurrent rotation and revocation. This is the schema target for independent inspection, not an import of legacy grant semantics.
- Login, consent, and logout keep strict canonical Origin checking and no-referrer. A nonce-protected same-origin script submits forms because real Chrome demonstrated that native form POSTs use Origin:null under no-referrer. No CSRF or Origin bypass was added.
- AbortSignal tears down fetch, sleep, and bridge delivery, but Prisma 6 has no query AbortSignal API. Already-dispatched database work can finish after sandbox cancellation. Strict immediate database termination requires a separately reviewed cancellable adapter/worker; production must use short statement/lock timeouts and bounded pools/concurrency. The allocation finding is fixed, but Task 6 is not a promise to roll back side effects on timeout.
- The Prisma tooling exception was accepted through 2026-10-06. No downgrade or unreviewed deepmerge major override was applied.
- Production TLS/proxy, network isolation, database permissions/timeouts, secrets, monitoring, and migration/recovery sign-off remain deployment-owner gates.

The detailed source filenames proposed in Task 2 were consolidated into
browser.ts for login/consent route rendering and authorization-server.ts for
protocol types; the session, credential, CLI, and rate-limit boundaries remain
separate. The externally callable auth-provider interface was preserved.
