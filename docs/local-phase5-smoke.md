# Local Phase 5 smoke setup

This setup starts a dedicated, trusted coding proxy while keeping the coding
worker untrusted and network-isolated. The proxy has the OpenAI credential and
database access. The worker receives only a one-run capability and can reach
only the proxy on its internal Docker network.

## Prerequisites

- Docker Desktop is running.
- `.env.local` contains `DATABASE_URL`, `OPENAI_API_KEY`, and `SECRET_APP_KEY`.
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
```

The second command prints a content-addressed `sha256:...` Docker image ID.
Use that exact value in `.env.local`; do not substitute the mutable image tag.
Then add the following values, replacing the image ID and GitHub values:

```dotenv
# Leave this as local until every value below is set and reviewed.
JOB_LAUNCHER=local
CODING_WORKER_IMAGE=sha256:replace-with-worker-image-id
CODING_PROXY_CONTAINER=reevo-coding-proxy
VCS_WORK_ROOT=/tmp/reevo-vcs
CODING_JOB_STATE_ROOT=/tmp/reevo-docker-jobs
CODING_ARTIFACT_ROOT=/tmp/reevo-coding-artifacts
CODING_OPENAI_CREDENTIAL_REF=env:OPENAI_API_KEY
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

## Stop the setup

```sh
npm run coding:local:down
```

This stops the local database and proxy but leaves the named Postgres volume in
place. It does not alter agent records, GitHub branches, or pull requests.
