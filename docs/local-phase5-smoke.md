# Local Phase 5 smoke setup

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

The GitHub App installation is the only step that cannot be created from this
repository. It is intentionally scoped to the test repository because a coding
run can push a branch and create a draft pull request.

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
CODING_PROXY_CONTAINER=reevo-coding-proxy
VCS_WORK_ROOT=/tmp/reevo-vcs
CODING_JOB_STATE_ROOT=/tmp/reevo-docker-jobs
CODING_ARTIFACT_ROOT=/tmp/reevo-coding-artifacts
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

Run the complete no-paid-service Claude gate before an opt-in live smoke:

```sh
npm run verify:claude-code
```

The live smoke remains manual because it spends provider credit and can create
a GitHub branch and draft pull request. Keep its budget deliberately small.

After the smoke completes, record the run ID, terminal result, pull-request
URL, and final cost in the release evidence. Close the fixture PR and delete
its `reevo/run-*` branch. The worker's volume, artifact, and trusted checkout
are already removed by terminal cleanup; do not retain them for debugging.

See [Phase 5 release gate](phase-5-release-gate.md) for the repeatable
automated checks, lifecycle audit fields, and incident cleanup procedure.

## Stop the setup

```sh
npm run coding:local:down
```

This stops the local database and proxy but leaves the named Postgres volume in
place. It does not alter agent records, GitHub branches, or pull requests.
