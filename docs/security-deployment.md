# Security deployment and recovery

Status: the secured self-hosted HTTP implementation was enabled on 2026-09-06
after its database, HTTP, browser, migration, and review gates passed. SR-009 is
accepted only for trusted build/migration tooling through 2026-10-06; deployment
controls in this guide still apply.

## Supported runtime and delegated operation

Use Node.js 22.12 or newer. The development machine's Node 20.11 is below an
existing dependency's minimum; verification uses an isolated Node 22 runtime.
Stdio remains local and trusted, with `LOCAL_PRINCIPAL` as its owner identity.
Delegated HTTP requires `AUTH_ISSUER`, `AUTH_JWKS_URI`, and `AUTH_AUDIENCE`.
`MCP_CANONICAL_URI` and `AUTH_AUDIENCE` must be identical normalized HTTPS URLs.
Only explicit loopback development may use HTTP.

Terminate TLS at the reverse proxy. Forward exactly the canonical Host,
including a non-default port, and block direct access to the application port.
The app does not trust Forwarded/X-Forwarded-* for identity, origins, or rate
limiting. Configure proxy rate/connection limits as well. Behind a proxy the
application's per-IP limiter sees the proxy's IP, so its limit is shared by
those clients; do not fix that by trusting arbitrary forwarded IP headers.

Browser origins default to the canonical origin. `MCP_ALLOWED_ORIGINS` accepts
comma-separated exact additional origins, without paths or wildcards. Login,
consent, and logout POSTs always require the canonical Origin, even when an
additional MCP browser origin is allowed. Tokens must have a nonblank subject
of at most 512 UTF-8 bytes. External subject spelling and case are preserved.

## Self-hosted provisioning

Generate three independent random 32-byte keys, each encoded as 64 hex
characters. `openssl rand -hex 32` generates one key; run it independently
for `AUTH_SIGNING_KEY`, `AUTH_CREDENTIAL_HASH_KEY`, and `SECRET_APP_KEY`.
Supply them through the deployment secret manager. Never put them in the
image, shell history, repository, issue comments, or logs. Existing signing
key strings are not automatically compatible with the new hex encoding.

Use the same database and credential hash key for provisioning and the server:

```sh
node dist/cli.js auth user create --subject user-identifier
node dist/cli.js auth user list
node dist/cli.js auth key create --subject user-identifier
node dist/cli.js auth key list --subject user-identifier
node dist/cli.js auth key revoke PUBLIC-KEY-ID
node dist/cli.js auth user disable --subject user-identifier
```

Creation prints the complete high-entropy login key once. Distribute it out of
band through a secure channel; plaintext cannot be recovered from the database.
Login keys expire after one year. For a lost key, create a replacement and
revoke the old public key ID. Revocation also revokes the user's existing
sessions and OAuth families. Disable is terminal through the CLI; reactivation
requires a separately reviewed operator workflow.

The browser login uses a single-use, cookie-bound challenge. Consent displays
the client, canonical resource, and exact supported scopes. Session tokens are
server-side hashes, with a 12-hour idle and 30-day absolute lifetime; HTTPS uses
`__Host-` cookies with Secure, HttpOnly, Path=/, and SameSite=Lax. Loopback-only
HTTP development uses explicitly named development cookies without Secure.
Sign-in rotates the token and revokes the previous presented session.

Auth forms require JavaScript. A nonce-protected same-origin fetch submits the
form while retaining Origin under `Referrer-Policy: no-referrer`; native form
POSTs otherwise send `Origin: null`. CSP permits only that per-response nonce
and same-origin connections. Null-origin requests remain rejected. This
behavior is covered by real Chrome, rather than only a synthetic cookie jar.
See the [Fetch standard](https://fetch.spec.whatwg.org/#append-a-request-origin-header).

Clients must re-register as public clients (`token_endpoint_auth_method=none`).
Only S256 PKCE and exact registered redirect strings are accepted. Redirects
must be HTTPS or loopback HTTP, without credentials or fragments. Registration
allows 1-10 redirects and a bounded client name. `AUTH_MAX_CLIENTS` defaults to
1000; PostgreSQL serializes capacity checks and shares rate limits across
processes. There is no confidential-client support or client secret.

Interactions expire after 10 minutes, authorization codes after 60 seconds,
access tokens after 10 minutes, and refresh families after 30 days. Code
consumption is atomic. Each refresh rotates its opaque token; reuse revokes the
whole family, including descendants. Access verification checks family and user
state, so revocation also invalidates existing access tokens. `/revoke` takes
the refresh token and public client ID. Do not retry a refresh with the same
token after an uncertain response; start a fresh authorization flow.

The server cleans expired auth rows every 15 minutes. Consumed refresh grants
remain until family expiry for reuse detection. Monitor cleanup failures.
Changing the credential hash key invalidates existing login keys, sessions,
codes, challenges, and refresh tokens. Rotate signing and credential keys
together during a planned global credential reset; provision new login keys
and reauthorize clients. Do not rotate `SECRET_APP_KEY` without a separate
encrypted-secret migration, or existing application secrets become unreadable.

## Migration and rollback

Migration `20260906040000_secure_self_hosted_oauth` deliberately drops the two
legacy OAuth tables and recreates incompatible secure state. All legacy
clients, codes, access tokens, refresh tokens, and login credentials must be
reissued. The verifier also rejects the legacy token shape, even with retained
signing material. No application principal or owned business data is deleted.

Stop issuance, take a backup of unrelated data, and use `prisma migrate deploy`
from a trusted migration job. Never use `db push` or edit an applied migration.
The schema adds users, hashed login keys, sessions, form challenges,
authorization interactions/codes, serialized refresh families/grants, and
shared throttling. Foreign keys and indexes are declared in both SQL and Prisma.

Restoring a full pre-fix backup would resurrect usable compromised credentials.
The secure recovery alternative restores unrelated tables only, with issuance
stopped. For a schema rollback, recreate empty legacy OAuth placeholders
before reapplying the security migration; never restore their contents. The
rehearsal script exercises migration, unrelated-data restoration, and
re-migration against synthetic data in an isolated container:

```sh
node scripts/security-migration-rehearsal.mjs
```

That script deliberately targets only container `wardby-security-20260906`,
database `wardby_security`, and freshly generated temporary schemas. Its
temporary schemas are removed after verification. It is not a production
backup or rollback command. Have a second reviewer inspect production backup,
recovery, auth identity derivation, CSRF, transactions, and SSRF before rollout.

## Durable executor

`EXECUTOR=dbos` tables live outside Prisma's migration chain: DBOS creates and
migrates its own `dbos` schema at `launch()`, so the database role used by the
server needs `CREATE` on that schema (not just the application schema Prisma
manages). `DBOS_EXECUTOR_ID` is required and must be unique per running
_process_ — two processes sharing an id each believe they own the other's
in-flight runs and re-drive them at launch, so the scheduler and the MCP
server must be given different values. There is deliberately no default:
`EXECUTOR=dbos` refuses to start without one.

**New data at rest.** Durable execution checkpoints every step's result into
`dbos.operation_outputs`: each turn's assistant text, every tool call's
arguments, every tool result in full, and the `load` step's pinned agent
fields plus each attached tool's source and `paramsZod`. That is the same
class of data as the `Run`/`Tool` tables — prompt content, tool output, and
anything a tool returned from a secret-bearing call — and it accumulates for
the life of every workflow record, with no retention limit of its own. Give
the `dbos` schema the same encryption-at-rest, access control, backup, and
backup-retention handling as the application schema, and prune completed
workflows periodically: `DBOS.deleteWorkflow(workflowID, deleteChildren?)`
removes one workflow and its step records (irreversible), or delete rows
directly from the schema's tables for a bulk retention job. Prune only
workflows in a finished status — deleting a PENDING record makes its run
unrecoverable, and the reconciler will reap it as `lost`.

**Version pinning across upgrades.** DBOS gates both recovery and dequeue on
`application_version`, which it computes from the registered code unless
`DBOS__APPVERSION` is set. After an SDK bump or any change to the workflow
wrapper, workflows recorded under the old version are never dequeued by the
new process: pin `DBOS__APPVERSION` per deploy, or drain in-flight runs before
upgrading. The executor no longer loops on those runs — `recover()` reports
the run `lost` as soon as it sees a version mismatch, and otherwise gives up
after three adoption attempts. That attempt counter is in memory and per
process, so it resets on restart.

**Rolling back, and rolling forward again.** Rolling back to
`EXECUTOR=in-process` is safe at any time: any DBOS run still in flight is
reconciled to `lost` once its heartbeat times out, because no executor is left
to recover it, and nothing else in the deployment depends on the `dbos`
schema. The return trip is the part to know about: those workflows are still
PENDING in the `dbos` schema, and re-enabling `EXECUTOR=dbos` with the same
executor id re-drives them at launch. They no longer re-spend — `executeRun`
short-circuits on any run whose row is already terminal, so a re-driven
workflow whose run was reaped as `lost` does no work and leaves the row
`lost` — but the workflows do wake up and run to completion in DBOS's own
records. Delete them (see pruning above) if you want the rollback to be final.

## Resource and networking limits

| Surface                        | Limit                                             |
| ------------------------------ | ------------------------------------------------- |
| MCP/webhook bodies             | 1 MiB raw bytes                                   |
| Auth bodies                    | 64 KiB raw bytes                                  |
| Request completion / headers   | 15 seconds / 10 seconds                           |
| Sandbox fetch                  | 8 MiB encoded and decoded, 5 redirects, 8 seconds |
| Bridge input / output          | 1 MiB / 12 MiB                                    |
| Parser input / console payload | 256 KiB / 16 KiB                                  |
| HTML links extracted           | 1000, with incremental result-byte accounting     |
| Random bytes                   | 65,536 bytes                                      |
| Host calls                     | 256 per invocation, at most 8 pending             |
| Datastore value / keys listed  | 1 MiB / 1000                                      |
| Datastore key / secret name    | 1024 bytes                                        |
| New secret plaintext           | 64 KiB                                            |

Oversized or malformed input fails explicitly. Existing oversized datastore
values/keys and secret ciphertext fail instead of entering Node allocations.
Response limits also apply after decompression. Fetch validates every redirect
and pins the validated DNS result to the connection while retaining Host and
TLS verification. Cross-origin redirects remove credentials, including custom
API-key headers; forwarding a request body across origins is rejected.

`WARDBY_FETCH_ALLOWED_HOSTS` accepts exact normalized hosts only. Private-host
allowlisting intentionally bypasses destination isolation for those hosts.
Separately deny metadata/private egress at the container/VPC/firewall layer.
Sandbox code can explicitly log secrets it has been given; log size limits do
not provide automatic redaction. Keep tool-authoring privileges restricted.
Public/non-owner tool listings expose only id/name/description; owners retain
their source and schema. Private agents are indistinguishable from missing IDs.

Cancellation stops bridge delivery, sleep timers, and in-flight network work.
Prisma 6's query interface does not accept an AbortSignal: an already-dispatched
database operation may finish after sandbox cancellation. Its returned data is
bounded before entering Node, but cancellation is not a transaction rollback.
Set a short database statement/lock timeout on the dedicated application role,
bound connection pools and concurrent invocations, and review a cancellable
database adapter or isolated worker if strict immediate termination is required.
Do not claim these per-invocation caps establish a whole-process memory ceiling.

## Images and dependency exception

```sh
docker build -f deploy/Dockerfile --target runtime -t wardby-runtime .
docker build -f deploy/Dockerfile --target migration -t wardby-migration .
```

The runtime runs as uid 1000 and contains the generated Prisma client, but no
Prisma CLI, `@prisma/config`, or `deepmerge-ts`. Its manifest drops development
dependencies and omits optional peers before installation. Merely running
`npm ci --omit=dev` is insufficient: Prisma client can pull the CLI as a peer.
Audit the shipped subset with `npm audit --omit=peer`. A plain audit may still
report intentionally omitted optional peers from the lockfile.

SR-009 remains present in the trusted build/migration toolchain. On 2026-09-06,
6.19.3 was the newest published Prisma 6 release and still included vulnerable
deepmerge-ts 7.1.5. The advisory fixes deepmerge-ts at 8.0.0; no compatible
Prisma 6 release was available. Neither npm's suggested 6.12 downgrade nor an
unreviewed dependency-major override was applied. See the
[advisory](https://github.com/advisories/GHSA-ggr8-5vv4-36mx).

Accepted exception: the owner accepted this risk on **2026-09-06** for trusted
build/migration jobs only, expiring **2026-10-06**. Do not load untrusted Prisma config or
run migration tooling in a request handler. Recheck upstream by that date;
otherwise plan a separately reviewed Prisma-major migration. CI deliberately
allows only the exact `@prisma/config`, `deepmerge-ts`, and `prisma` chain for
GHSA-ggr8-5vv4-36mx and fails for any other advisory or after expiration. Raw
`npm audit` remains nonzero, so the policy wrapper must stay in the security job.
Vitest and esbuild's additional development advisories were remediated by
supported tooling updates.

## Verification and rollout

Install the test browser with `npx playwright install chromium`; on this
machine `SECURITY_BROWSER_CHANNEL=chrome` uses installed Chrome in an isolated
headless profile. Database-backed and browser tests are not release evidence
when skipped. Use a disposable `DATABASE_URL`, then run typecheck, full tests,
contract tests, build, Prisma validation, migration replay/drift/recovery, and
`node scripts/security-audit.mjs`. The CI job runs database tests and archives a dependency tree.
After building, `node --expose-gc scripts/security-allocation-check.mjs` checks
stream abortion, read-ahead, and process-memory growth for an endless response.

Before external rollout, verify proxy TLS/Host normalization, blocked direct
ingress, egress policy, least-privilege encrypted database access, secret-manager
injection, credential-free access logs, and alerts for 401/403/413 responses,
blocked fetches, cleanup failures, and memory pressure. These deployment gates
cannot be established by local source tests alone.
