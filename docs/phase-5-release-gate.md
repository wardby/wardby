# Phase 5 Release Gate

Date: 2026-09-08

Phase 5 is the containerized coding-agent path: a trusted control plane accepts
an owned coding request, an untrusted worker modifies a checkout, and trusted
GitHub finalization creates at most one draft pull request.

## Evidence

Run the local, no-paid-service gate from the repository root:

```sh
npm run verify:phase5
npm run test:phase5:database
npm run worker:image:local
npm run test:docker-isolation
npm run test:docker-job
```

`test:phase5:database` requires a migrated PostgreSQL test database through
`DATABASE_URL`; it deliberately stays separate so the fast local gate does not
silently pass by skipping persistence coverage.

The CI `Security checks` workflow additionally builds the worker image, creates
an SPDX SBOM, scans it with Trivy, performs migration-backed tests, and runs the
Docker isolation suite. A release uses that workflow's artifacts for the exact
commit being released.

The opt-in live smoke is documented in [local-phase5-smoke.md](local-phase5-smoke.md).
It must use a dedicated GitHub App installation, a dedicated fixture repository,
a tiny coding budget, and a unique `reevo/run-*` branch. Verify one draft pull
request, record its run ID and cost, then close the test pull request and delete
the generated branch.

### Live Smoke — Recorded Evidence

- **Run ID:** `cmts0srn20002sqqadk0asd7i`
- **Date:** 2026-09-08 01:58 UTC
- **Agent:** `phase5-local-smoke` (`gpt-5.6-luna`, budget $0.25)
- **Task:** create one file (`phase5-smoke.md`) at the repository root with
  exact specified content; no other file modified.
- **Outcome:** `pull_request_opened` — [PR #1](https://github.com/chfields/reevo-run/pull/1)
  on `chfields/reevo-run`, commit `36971b0be5a2dd1ab06142aa65db2a37a6127880`,
  branch `reevo/run-cmts0srn20002sqqadk0asd7i`.
- **Cost:** $0.007158 (71,847 input / 1,103 output tokens) against the $0.25
  budget.
- **Verification:** the requested file's exact-content check passed.
- **Cleanup:** PR #1 closed at 02:03:57 UTC (~5 min later); branch deleted
  from `origin`. Both confirmed via `gh pr view` / `git ls-remote` after the
  fact — this section was not filled in at the time of the run, only
  reconstructed from `CodingRun`/`Run` table state and GitHub afterward.
- **Context:** 9 prior attempts against the same agent failed or were
  cancelled before this one succeeded — expected iteration, not a first-try
  result.

- **Run ID:** `cmtu0dxkp0002sqbwy1jnxkj3`
- **Date:** 2026-09-09 11:22 UTC
- **Agent:** `phase5-local-smoke` (same agent/repo as above)
- **Task:** create one new file (`hello.py`) at the repository root — a
  classic Python "Hello, World!" program (`print("Hello, World!")`); no
  other file modified.
- **Outcome:** `pull_request_opened` — [PR #2](https://github.com/chfields/reevo-run/pull/2)
  on `chfields/reevo-run`, commit `fe5afef8eff08ae881899a4c2899eed27568177f`,
  branch `reevo/run-cmtu0dxkp0002sqbwy1jnxkj3`.
- **Cost:** $0.00606 (50,255 input / 986 output tokens) against the $0.25
  budget.
- **Verification:** file content and line count verified correct
  (`print("Hello, World!")`, exactly as requested) by manual diff review
  (`gh pr diff`) after the run. The worker's own runtime check
  (`python3 hello.py`) reported `skipped` — `python3` is not installed in
  the worker image, so it could not execute what it wrote; this is an
  environment gap, not a correctness failure (the code is valid and
  correct on inspection).
- **Cleanup:** PR #2 closed and its branch deleted from `origin`
  immediately after review, same day as the run — recorded live this time.

## Lifecycle Audit And Metrics

The container executor emits metadata-only structured events for `queued`,
`prepared`, `launched`, `running`, `budget_cutoff`, `stopping`, `collected`,
`pull_request_opened`, `terminal`, and `cleanup`. Events contain only run ID,
opaque job ID, outcome, sanitized failure category, opaque diagnostic ID,
duration, and budget totals. They never contain task text, prompts, repository
files, diffs, environment values, raw logs, or credentials.

The same event stream maintains queue and runtime totals, terminal outcomes,
active-job count, budget reserved versus actual spend, and cleanup-failure
count. Configure the production log/metrics collector to retain these
metadata-only events for 90 days, or the organisation's stricter policy.
Diagnostic IDs are correlation keys for the protected operator log sink, not
references to source data.

`CodingRun.failureCategory` and `CodingRun.diagnosticId` retain only sanitized
terminal metadata. Apply the normal run-record retention policy to those rows;
the database must not be used to retain source volumes, artifacts, prompts, or
worker output.

## Retention And Recovery

Worker volumes, input artifacts, trusted Git workspaces, and Docker jobs are
ephemeral. Terminal completion, cancellation, and failure remove them. On
restart, the reconciler asks the persisted executor handle to converge cleanup;
an ambiguous provisioning attempt is marked lost rather than relaunched.

The proxy ledger keeps only the information required to reconcile usage while a
session is active. Do not export request bodies, upstream authorization headers,
or worker logs to the audit sink. Docker's local log driver is capped at 2 MiB
per worker and is collected only as bounded, fixed diagnostic metadata.

## Supported And Deferred Scope

Phase 5 supports Codex through a trusted OpenAI-compatible budget proxy,
GitHub App checkout and draft-PR finalization, and the Docker JobLauncher.
It does not support Claude Code, GitLab or Bitbucket, Fargate, GitHub Actions as
a launcher, auto-merge, owner-approved workflow-file editing, PR update loops,
or guaranteed test success. DBOS durable execution is implemented separately in
Phase 6; it does not resume an in-flight isolated coding job.

## Operator Review

Before enabling a repository, review the coding profile's repository, base ref,
protected paths, allowed egress, timeout, image digest, resource limits, and
budget. Grant the GitHub App only Contents and Pull requests read/write access
on that repository. Treat Docker-daemon access and the proxy host as privileged
administrative access.

For an incident, cancel the run through MCP or `reevo coding cleanup --run-id
<id>`, revoke the GitHub App installation or OpenAI credential if necessary,
and use the diagnostic ID to locate sanitized operator logs. Never recover a
worker filesystem or raw prompt from logs.
