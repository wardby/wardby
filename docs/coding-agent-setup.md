# Local coding-agent setup

This setup starts a dedicated, trusted coding proxy while keeping the coding
worker untrusted and network-isolated. The proxy has the selected provider
credential and database access. A worker receives only a one-run capability
and can reach only the proxy on its internal Docker network. Claude Code uses
a second, networkless tool-runner container for repository access.

## Prerequisites

- Docker Desktop is running.
- `.env.local` contains `DATABASE_URL`, `SECRET_APP_KEY`, and the credential
  for each enabled coding provider: `OPENAI_API_KEY` and/or
  `ANTHROPIC_API_KEY`.
- The local database has the current Prisma migrations applied.
- A GitHub App is installed on only the repository to be exercised. Grant it
  `Contents: Read and write` and `Pull requests: Read and write`; set
  `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in `.env.local`.

GitHub documents the available App permissions in its [permissions guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).
The same App can also run native agents as automated PR reviewers; see
[code-review-agents.md](code-review-agents.md) for the extra webhook
permissions and setup.

The GitHub App installation is the only step that cannot be created from this
repository. It is intentionally scoped to the test repository because a coding
run can push a branch and create a draft pull request.

## Repository authorization

A coding agent's `codingProfile.repository` must be authorized for the agent's
owner: `create_agent` and `update_agent` (when the repository changes) check
that the owner's linked GitHub account has **write** access to it, or record
an explicit admin approval (`repositoryAdminOverride: true`, `admin` role
only). Link your GitHub account once with `link_host_account` first; see
[code-review-agents.md](code-review-agents.md#who-may-give-an-agent-a-repository),
which also covers the App's callback URL and client credentials
(`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`).

Every run checks again, before its workspace is prepared, against the agent's
current owner. A run whose owner has lost write access, unlinked their GitHub
account, or whose repository was never authorized ends `refused` with failure
category `repo_access` and nothing cloned. The check is repeated (usually from
the 5-minute cache) right before the run pushes: access lost while it worked
fails the run (`repo_access`) with nothing pushed. For a run already under way,
a transient GitHub error during either check is retried once; if it persists
the run fails with category `repo_access_unavailable` (GitHub could not be
asked — not a lost permission; re-run it later). `make_owner` to a different
owner turns an admin or grandfathered approval into a check of the new owner's
access. Coding agents must have an owner.
Over stdio, the local operator holds every role, so `repositoryAdminOverride`
is the way to approve a repository there.

## Start the trusted proxy

Run these commands from the repository root:

```sh
npm run coding:local:up
npm run worker:image:local
npm run claude:images:local
```

The image commands create local tags. Resolve every enabled image with
`docker image inspect --format '{{.Id}}' <tag>` and put the resulting immutable
`sha256:...` ID in `.env.local`; do not use the mutable tag at runtime. Add the
following values, replacing image IDs and GitHub values:

```dotenv
# Leave this as local until every value below is set and reviewed.
JOB_LAUNCHER=local
CODING_WORKER_IMAGE=sha256:replace-with-worker-image-id
CODING_CLAUDE_WORKER_IMAGE=sha256:replace-with-claude-worker-image-id
CODING_CLAUDE_TOOL_RUNNER_IMAGE=sha256:replace-with-claude-tool-runner-image-id
CODING_PROXY_CONTAINER=wardby-coding-proxy
VCS_WORK_ROOT=/tmp/wardby-vcs
CODING_JOB_STATE_ROOT=/tmp/wardby-docker-jobs
CODING_ARTIFACT_ROOT=/tmp/wardby-coding-artifacts
CODING_OPENAI_CREDENTIAL_REF=env:OPENAI_API_KEY
CODING_ANTHROPIC_CREDENTIAL_REF=env:ANTHROPIC_API_KEY
GITHUB_APP_ID=replace-with-app-id
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
```

Once the GitHub App values are set and the target repository has been reviewed,
change `JOB_LAUNCHER=docker` and run:

```sh
npm run cli -- coding preflight
```

The preflight checks that Docker can inspect the immutable worker image. A real
run additionally verifies the proxy's isolated-network attachment immediately
before launching the worker.

Run the no-paid-service verification gates before an opt-in live smoke:

```sh
npm run verify:phase5
npm run test:phase5:database
npm run test:docker-isolation
npm run test:docker-job
npm run verify:claude-code
```

The live smoke remains manual because it spends provider credit and can create
a GitHub branch and draft pull request. Keep its budget deliberately small.

After the smoke completes, verify the run ID, terminal result, pull-request
URL, and final cost. Close the fixture PR and delete its `wardby/run-*` branch.
The worker's volume, artifact, and trusted checkout should be removed by
terminal cleanup; investigate any retained resource as a cleanup failure.

See [release verification](release-verification.md) for the complete gate.

## Budgets

A coding run's budget is reserved when it is dispatched: the agent's own
`budgetUsd`, tightened to whatever its budget group has left for each
configured period and, for a sub-agent, whatever its run tree has left. The
worker can never spend more than that reservation. When a group or run tree
has nothing left, the run is recorded as `refused` with the error
`budget_group_exhausted:<day|week|month>` or `run_tree_exhausted`, and no
container starts. Every run still pending or running holds its unspent
reservation (reservation minus cost so far) against its group; a native run
holds its agent's per-run `budgetUsd`. So overlapping scheduled, webhook and
manual runs share one cap rather than each seeing the full remainder, and
`get_budget_group` reports those holds as `reservedUsd` next to `spentUsd`.

## Stop the setup

```sh
npm run coding:local:down
```

This stops the local database and proxy but leaves the named Postgres volume in
place. It does not alter agent records, GitHub branches, or pull requests.
