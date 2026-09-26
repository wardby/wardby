# Security deployment and recovery

The secured self-hosted HTTP implementation is protected by database, HTTP,
browser, migration, and review gates. `npm install @wardby/cli` installs
audit-clean: the published package no longer installs the Prisma CLI, and the
repository's development tree is clean by reviewed overrides. Deployment
controls in this guide still apply.

## Supported runtime and delegated operation

Use Node.js 24 or newer. Development pins Node 24 through `.nvmrc`, and the
production runtime image is built on a pinned Node 24 base image.
Stdio remains local and trusted, with `LOCAL_PRINCIPAL` as its owner identity.
It holds every scope and every role.
Delegated HTTP requires `AUTH_ISSUER`, `AUTH_JWKS_URI`, and `AUTH_AUDIENCE`.
`MCP_CANONICAL_URI` and `AUTH_AUDIENCE` must be identical normalized HTTPS URLs.
Only explicit loopback development may use HTTP.
Follow [Bring your own identity provider](getting-started-identity-provider.md)
for the complete audience, scope, client-registration, configuration, and
verification procedure.

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
node dist/cli.js auth user create --subject operator-identifier --role admin
node dist/cli.js auth user list
node dist/cli.js auth user grant --subject user-identifier --role package-approver
node dist/cli.js auth user grant --subject user-identifier --revoke-role package-approver
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

The CLI rejects any flag a command does not take, for example
`auth key create --role admin`. It also rejects any unknown role name.
`auth user grant` changes only an existing user and never creates one. Both
`--role` and `--revoke-role` can be repeated.

## Roles and privileged operations

Scopes and roles do different jobs:

- **Scopes delegate.** A token's scopes are what the user let a client do on
  their behalf. A user may consent to any supported scope, and issuing a token
  never depends on roles.
- **Roles authorize.** A user has a set of roles. With no roles, the user is a
  member:

| Role               | Grants                                                          |
| ------------------ | --------------------------------------------------------------- |
| `admin`            | `agents:admin` and `packages:approve`                           |
| `package-approver` | `packages:approve`                                              |
| (none)             | nothing privileged; every other scope works as the token allows |

Four operations are privileged:

- `make_owner`, which reassigns any agent's owner, including another
  principal's private agent (see [Sharing agents](#sharing-agents) for what
  moves with it);
- setting a BYO `workerImageRef`;
- approving coding agents' package allowlists or policy;
- approving a repository for an agent without checking GitHub access
  (`adminOverride` on `link_repository`, `repositoryAdminOverride` on
  `create_agent`/`update_agent`; see [Repository access](#repository-access)).

Each needs **both** its scope on the token **and** a role that grants that
permission:

- `make_owner`, `workerImageRef`, and repository approval need `agents:admin`.
- Package approval needs `packages:approve`, or `agents:admin`.

In practice:

- an `admin` can do all four;
- a `package-approver` can approve packages only;
- a member can do none of them.

Callers who fail the check get `403`:

- A caller whose token holds the scope but whose roles don't grant it gets a
  "requires a role" error. Authorizing again for more scopes can't fix this;
  an operator has to grant a role.
- A caller who has a role granting the permission but whose token lacks the
  scope gets the usual `insufficient_scope` challenge, naming the scope to
  request. For package approval, that is the alternative their role grants.

Roles are read from the database on every request and are never cached.

**Any role change signs the user out.** This applies to both `--role` and
`--revoke-role`. In the same transaction, `auth user grant` revokes all of the
user's:

- OAuth grant families and refresh tokens;
- browser sessions;
- unexchanged authorization codes.

Every client must sign in and authorize again. The user sees the scopes afresh
under their new roles. This has two consequences:

- A token minted under the old roles can never regain that reach if a role is
  granted again later.
- A grant the user consented to while a privileged scope was inert (for
  example, an MCP client that requested every scope) never silently gains
  privileged reach through a promotion.

A change that leaves the roles as they were, such as revoking a role the user
doesn't hold, revokes nothing.

The other scopes are not privileged. Every agent tool also checks the
caller's access to that agent, its owner or an explicit grant (see
[Sharing agents](#sharing-agents)); a scope never reaches an agent the caller
has no access to.

**Upgrading:** every existing self-hosted user starts with no roles, including
the operator. After deploying, grant yourself the admin role, then reconnect
your MCP client:

```sh
node dist/cli.js auth user grant --subject YOUR_SUBJECT --role admin
```

In delegated mode, roles come from a signed access-token claim that you map
with `AUTH_ROLE_CLAIM` and `AUTH_ROLE_MAP`. See
[Bring your own identity provider](getting-started-identity-provider.md#wardby-roles).
If you leave them unset, nobody has a role and the privileged operations are
refused over HTTP.

The browser login uses a single-use, cookie-bound challenge. Consent displays
the client, the canonical resource, and exactly the scopes approval issues: the
supported part of the request, fixed when the authorization request is created. Session tokens are
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

## Sharing agents

An agent is private to its owner unless the owner shares it. A grant is
`(agent, grantee, level)`; the grantee is one principal or **everyone**:

| Level     | Lets the grantee                                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`    | see the agent's config (never secret values, never other owners' tool code), list its sub-agents                                                               |
| `execute` | also trigger runs, and see the runs they triggered                                                                                                             |
| `write`   | also change its name, prompt, model, budget amount, max turns, effort, memory on/off and schedule; attach tools they can use and detach tools; create webhooks |
| owner     | everything, plus the owner-only operations below                                                                                                               |

Owners manage grants with `grant_access`, `revoke_access` and `list_access`.
Granting again replaces the level. A revoke takes effect on the next check
(trigger, delegation, webhook fire); runs already in flight keep going.

**Owner-only, whatever the grants:** `delete_agent`, managing grants, the
agent's secret, datastore and repository bindings, the whole coding profile
(task, base ref, protected paths, task-override opt-in, image, packages,
toolchain, limits), changing its kind, its budget group, attaching or
detaching sub-agents, reading or writing its memory and datastore contents,
and granting capabilities to a tool attachment.

**What execute hands over.** An execute-grantee runs your agent with your
tools, secrets, datastores and repository, and every run shares the agent's
memory. A non-owner supplies no instructions of their own: a native agent
takes no task text from `trigger_agent` or from another owner's sub-agent
delegation, and a coding agent takes a `task` or `baseRef` from a non-owner
only if `codingProfile.allowWebhookTaskOverride` is on (the same opt-in
webhooks use); otherwise the run uses your `defaultTask`. Webhooks still
accept task text for native agents (the webhook creator needs `write` to make
one). Runs are visible to their triggerer and to you, never to other
grantees.

**What write hands over.** A write-grantee can rewrite what the agent's runs
do, but not add to what they can reach. The prompt can make a run use
everything the agent already reaches: the tool capabilities you granted, its
memory, and its linked repositories. On a coding agent the prompt is part of
every coding task, so write directs work done with your GitHub access; grant
write on such an agent only to someone you'd let push. What stays yours: the
four capability fields on a tool attachment (`allowedSecrets`,
`allowedDatastorePrefixes`, `allowedHosts`, `allowedSharedDatastorePrefixes`),
so a tool a write-grantee attaches runs with none until you re-run
`attach_tool` with them (you then vouch for code only its owner can read);
the coding profile, kind and budget group; and sub-agents, since an edge
would hand every run's data to another agent.

**Everyone** can be granted at most `execute`: everyone-write would let
anyone rewrite an agent that holds your tools and secrets.

**Nothing crosses owners without a grant on that exact resource**, checked
when bindings are written and again at run time, so rows written before this
rule (or left behind by `make_owner`) stop working on their own:

- a secret or datastore binding resolves only while the resource's owner is
  the agent's current owner; any other binding behaves like an unattached
  name;
- a tool attachment's capabilities count only while the agent's current owner
  granted them;
- a sub-agent runs only if it has the parent's owner, or the parent's owner
  holds `execute` on it (`attach_subagent` is the parent's owner's, with
  `execute` on the child). Across owners, the edge carries no memory access,
  no `grantParentMemoryKeys`, no `continuePriorRun`, no task text for a
  native child (it runs its own prompt), and no coding task unless the child
  allows non-owner task text. The child's owner can always detach it;
- a webhook fires only while its creator owns the agent or holds `execute`.

**The stdio operator** (`wardby mcp` over stdio) is owner of every agent for
access checks and sees every agent, but does not bypass the binding rules:
it can't bind its own secret to someone else's agent, and it is not the owner
for coding-profile changes, coding task overrides or sub-agent edges on
someone else's agent (it can adopt the agent first). An HTTP user whose
subject equals `LOCAL_PRINCIPAL` is not the operator. **Admins** get no
implicit access to others' agents: they can `list_access` any agent (incident
response) and reassign one with `make_owner`, which removes bindings the new
owner doesn't own, suspends tool capabilities the new owner never granted,
cuts sub-agent edges the new owner can't delegate, and, between two owners,
resets every grant. Adopting an owner-less agent keeps its grants but lowers
an everyone grant to `read` unless `keepEveryoneExecute` is set.
`make_owner` no longer releases an agent to owner-less.

### Upgrading: owner-less agents

Before this release, an agent with no owner was public: anyone could read
**and change** it. The migration keeps such agents runnable by giving each an
everyone-`execute` grant; nobody but the stdio operator can edit them until
they get an owner. Until then they run without owned secrets or datastores and
without their tools' capabilities. Operator runbook:

1. On the old version, with the new binary:
   `wardby grants migration-report > before.txt`. It is read-only and lists
   owner-less agents (and, per possible adopter, which secrets, datastores
   and tool capabilities adopting would bring back), the bindings and
   capabilities that will stop working, owner-less-tool capabilities that
   stay in force on owned agents (review them if the agent ever changed owner
   with `make_owner`), sub-agent edges that will be refused, webhooks that
   won't fire, and the behaviour changes.
2. `prisma migrate deploy` (`npm run prisma:migrate`), then roll out. The
   migration needs PostgreSQL 13 or later.
3. Immediately: `wardby grants adopt-public --owner <subject> --dry-run`,
   then the same without `--dry-run`. Every owner-less agent gets that owner;
   its everyone grant is lowered to `read`, because the agent is about to
   regain the owner's secrets and capabilities (pass
   `--keep-everyone-execute` to keep it runnable by everyone, knowingly;
   webhooks others created stop firing otherwise). The owner's own bindings
   come back to life, the others are removed and printed; attachments of the
   owner's own tools regain their capabilities; every other attached tool is
   printed for review, with the `attach_tool` call that re-grants any
   capabilities it had. The subject must already exist.
4. `wardby grants prune-bindings` removes, and prints, every remaining
   binding of one owner's secret or datastore to another owner's agent
   (already inert).
5. `wardby grants migration-report > after.txt`.

`wardby agent create` now owns the agent by `--owner <subject>` or
`LOCAL_PRINCIPAL` (`--public` adds everyone-`execute`), `wardby tool attach`
grants capabilities in the agent owner's name, and `wardby import --public`
owns the imported agents by `--owner` or the importing operator, shared with
everyone at `execute`.

## Repository access

The GitHub App is installed on repositories by their owners, not per wardby
user, so "the App can reach it" is not permission to use it. An agent may use
a repository — a `link_repository` link, or a coding agent's
`codingProfile.repository` — only when:

- its **current owner's** GitHub account, linked with `link_host_account`, has
  enough permission on it: write for coding repositories and write links
  (they push, comment, and publish checks), read for read links; or
- a wardby `admin` approved that exact repository explicitly; the approval is
  recorded (who, when); or
- the authorization predates enforcement (`grandfathered`, stamped by the
  migration).

Trust assumptions:

- **The owner's access decides, not the trigger's.** Whoever triggers a run (a
  schedule, a webhook, a host event, the owner, an `execute`-grantee) only
  supplies task text, and a non-owner supplies coding task text only when the
  owner enabled `allowWebhookTaskOverride`; the owner controls the tools,
  secrets and repository. A repository is a binding: only the owner (or an
  admin's explicit approval) sets it, never a `write`-grantee.
- **Owner-less agents never hold a repository**, even admin-approved: there is
  no owner whose GitHub access can be checked. Assign an owner first.
- **Checked where it's used.** Every coding run (before its workspace is
  prepared, and again right before it pushes), every `repo_*` call, and every
  host-event dispatch re-checks a `host_permission` authorization against the
  current owner, with a 5-minute cache. A GitHub error refuses the use; for a
  run already under way, a transient error (5xx, timeout, rate limit) is
  retried once, then refused with its own category
  (`repo_access_unavailable`). Set-time checks never retry.
- **Approvals stay with the owner they were granted under.** Admin and
  grandfathered authorizations are not re-checked while the agent keeps its
  owner; revoke them by unlinking or changing the repository. `make_owner` to
  a different owner converts them into checks of the next owner's own GitHub
  access; only an owner-less agent's first owner keeps them.
- **Admins approve explicitly, on any owned agent.** `adminOverride` works on
  agents the admin doesn't own (the admin role can already reassign any
  agent); it is always recorded with the approver. On another's agent an
  admin can change only the repository.
- **Public repositories:** GitHub reports read access for everyone, so any
  linked principal may create a `read` link to a public repository the App is
  installed on. Only public data is exposed that way.
- **Identity is proven, not claimed.** Linking uses the App's OAuth web flow
  with single-use state, S256 PKCE, and a one-time confirmation code that
  only the initiating principal can submit, so a victim clicking an attacker's
  link can't bind their GitHub account to the attacker. wardby keeps only the
  GitHub numeric user id and login; the user token is revoked immediately.
  Permission checks use the App's installation token. One GitHub account links
  to one principal.
- **Mentions need push access.** An `@<app-slug>` mention runs an agent only
  when its author has write access to the repository, checked live by user id.
- **Checks are bound to the dispatched PR.** A review publishes a check only on
  the pull request its run was dispatched for; fork PRs are never dispatched.

Before upgrading, find owner-less agents that have a repository link or a
coding profile (`list_agents`, `list_repositories`) and give each an owner
with `make_owner` (or `wardby grants adopt-public`), or they stop running. See
[code-review-agents.md](code-review-agents.md#who-may-give-an-agent-a-repository)
for the App settings (callback URL, client ID and secret).

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
migrates its own `dbos` schema (`DBOS_SCHEMA`) at `launch()`. On a fresh
schema that starts with `CREATE SCHEMA IF NOT EXISTS`, which Postgres checks
against `CREATE` on the _database_ even when the schema already exists, so a
server role limited to data access cannot launch DBOS on its own. Either give
the server's role that privilege, or migrate the schema out of band as a
privileged role with `npm run dbos:migrate` (`dbos schema "$DATABASE_URL"`)
and grant the server's role `USAGE` on the schema plus `SELECT`, `INSERT`,
`UPDATE` and `DELETE` on its tables, with default privileges for tables a
later SDK version adds. Once the schema is current, `launch()` changes
nothing. The GKE module does the latter (`deploy/gke/database-grants.sql`).

`DBOS_EXECUTOR_ID` must be unique per running _process_ — two processes
sharing an id each believe they own the other's in-flight runs and re-drive
them at launch. Left unset, each process generates a random one, which is the
safe default: a process that replaces a dead one does not need its id,
because the reconciler adopts any live workflow whose run's heartbeat has gone
stale, whichever executor id owns it. Set a fixed id only for a single,
long-lived process that should re-drive its own runs at launch rather than
after the heartbeat timeout.

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
executor id re-drives them at launch. (With a random per-process id, nothing
re-drives them: they stay PENDING until pruned.) They no longer re-spend — `executeRun`
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

Every resolved address must be global. A tool's own `allowedHosts` only
narrows egress; it never opens a private, loopback or link-local destination.
Only the operator's `WARDBY_FETCH_ALLOWED_HOSTS` (exact normalized hosts) can,
and a non-wildcard tool must list the host too. Cloud metadata endpoints
(`169.254.169.254`, `169.254.169.252`, `169.254.170.2`, `169.254.170.23`,
`100.100.100.200`, `fd00:ec2::254`, `fd00:ec2::23`, `fd20:ce::254`, their
mapped/NAT64/6to4 IPv6 forms, `metadata.google.internal`, `metadata`) are
always blocked, even if listed.
The network layer cannot back this up for the control plane on GKE, because
Workload Identity needs the metadata server.
Sandbox code can explicitly log secrets it has been given; log size limits do
not provide automatic redaction. Keep tool-authoring privileges restricted.
Public/non-owner tool listings expose only id/name/description; owners retain
their source and schema. Private agents are indistinguishable from missing IDs.

Cancellation stops bridge delivery, sleep timers, and in-flight network work.
Prisma's query interface does not accept an AbortSignal (still true on Prisma
7's `pg` driver adapter): an already-dispatched database operation may finish
after sandbox cancellation. Its returned data is
bounded before entering Node, but cancellation is not a transaction rollback.
Set a short database statement/lock timeout on the dedicated application role,
bound connection pools and concurrent invocations, and review a cancellable
database adapter or isolated worker if strict immediate termination is required.
Do not claim these per-invocation caps establish a whole-process memory ceiling.

## Coding runs on Kubernetes

`JOB_LAUNCHER=kubernetes` runs each coding agent in its own pod instead of a
container. The trust model is unchanged — the worker is untrusted, holds no
provider credential, and may reach only the coding proxy — but a cluster
enforces that differently from a Docker host, and two controls exist because a
cluster's configuration cannot be taken on trust.

**The pod is attested before the worker runs.** The pod and NetworkPolicy read
back from the API server are compared field by field against what wardby built.
Any difference fails the launch closed. This is what catches a mutating
admission controller, or anyone with cluster access, weakening a pod's isolation
between creation and start. Only an explicit list of known server defaults is
normalized away; nothing else is tolerated.

**Enforcement is proven, not assumed.** A cluster accepts a NetworkPolicy
whether or not its CNI enforces one, and even where enforcement works it is
programmed seconds after a pod starts. Before releasing the worker, the launcher
connects from inside the pod to a destination that must be blocked and requires
three consecutive refusals. A cluster that does not enforce policy, or has not
yet programmed this pod's rules, never reaches the point of running agent code.
The same check runs at startup against a throwaway canary pod, which also
verifies the pod cannot reach DNS, the internet or the cloud metadata endpoint.

**RBAC.** The control plane needs a namespace Role (`pods`, `pods/exec`,
`pods/log`, `secrets`, `configmaps`, `networkpolicies`, `services`) and a
ClusterRole granting `get` on the single namespace it runs in, because the
preflight's namespace read is cluster-scoped. Workers get a dedicated
ServiceAccount with no permissions and no mounted token. Reference manifests are
in `deploy/kind-coding/manifests/`.

**Sandboxing.** The spec requires gVisor on GKE; the reference `kind` harness
has none, so that configuration is development-only and says so. Set
`KUBERNETES_RUNTIME_CLASS` to the cluster's sandboxed runtime class in
production; the launcher warns loudly when it is unset.

The `gke-autopilot` platform profile contains narrow admission allowances
captured from a real cluster and requires the `gvisor` runtime class. A dry-run
capture cannot observe labels added after pod scheduling, so live-run behavior
is pinned separately by tests. Run `wardby coding preflight` against every
target cluster before accepting work; it fails closed when admission or network
behavior differs from the reviewed profile.

Before production deployment, review the
[current Kubernetes limitations](coding-worker-isolation.md#known-limitations).
Per-run record ConfigMaps currently require operator-managed garbage collection,
Claude Code is not supported by the Kubernetes launcher, and the real-cluster
suite does not yet cover every Docker containment scenario.

## Coding package registry

Enabling a coding agent's package allowlist widens the trusted proxy's own
egress, not the worker's: the proxy (the only host any worker can reach) is
additionally permitted to reach `registry.npmjs.org`, `pypi.org`,
`files.pythonhosted.org`, and `api.osv.dev`, through the same pinned HTTPS
fetch used for everything else it calls out to (no redirects, no private or
IP-literal addresses). The worker's own network reachability is unchanged: it
still reaches only `wardby-proxy:8787`. See
[Installing packages in coding runs](coding-packages.md) for the full model,
including its per-run download limits.

Two of that page's safeguards are worth calling out for an operator: npm
install scripts are disabled only by a configuration default
(`npm_config_ignore_scripts=true`) that the proxy cannot enforce against a
downloaded tarball, so treat it as a documented limit rather than a
guarantee; and the OSV vulnerability audit fails **closed**
(`503 wardby_audit_unavailable`) when OSV can't be reached, unless the
operator explicitly sets `REGISTRY_AUDIT_FAIL_OPEN=true` to allow installs
through unaudited during an OSV outage.

## Images and dependencies

```sh
docker build -f deploy/Dockerfile --target runtime -t wardby-runtime .
docker build -f deploy/Dockerfile --target migration -t wardby-migration .
```

The runtime runs as uid 1000 and contains the generated Prisma client (compiled
into `dist/generated/prisma`) with `@prisma/client`'s runtime and the `pg`
driver adapter, but no Prisma CLI, `@prisma/config`, `deepmerge-ts` or `mysql2`
(the image build asserts this). Its manifest drops development dependencies and
omits optional peers before installation: `@prisma/client` declares the CLI as
an optional peer. The migration image keeps the full build tree -- the Prisma
CLI and `prisma.config.ts`.

**Development tree (repository, CI, build and migration images).** The Prisma
CLI (a devDependency since the Prisma 7 upgrade) still carries two flagged
packages, both forced to patched versions by `overrides` in `package.json`:

```json
"overrides": { "deepmerge-ts": "8.0.2", "mysql2": "3.24.4" }
```

- `deepmerge-ts`: `@prisma/config` 7.10.0 still pins 7.1.5 exactly. The 8.x
  override is safe because `@prisma/config` calls only `deepmerge()`; the 8.0
  breaking changes are two type renames and `deepmergeInto`, which Prisma does
  not call.
- `mysql2` (GHSA-3f6p-5ww8-9rcr, GHSA-rgwj-5xj2-c3m3, high): `prisma` 7.10.0
  pins 3.15.3 exactly; it is used only by Prisma Studio's MySQL executor
  (`createPool` from `mysql2/promise`), never by wardby, which is
  PostgreSQL-only. 3.24.4 is the same major. After changing either override,
  re-run `prisma generate`, `prisma validate`, the `migrate diff` drift check,
  and the migration image's `migrate deploy`.

`scripts/security-audit.mjs` carries no exceptions: with the overrides the full
and production audits are clean, and if a lockfile change ever dropped one, the
advisory would reappear and the security job would fail.

Prisma's npm `latest` dist-tag currently points at an 8.0 release candidate, so
pin exact versions (the build hides the CLI's update banner, which recommends
it).

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
