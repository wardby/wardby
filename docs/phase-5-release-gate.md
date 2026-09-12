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
npm run verify:claude-code
```

`test:phase5:database` requires a migrated PostgreSQL test database through
`DATABASE_URL`; it deliberately stays separate so the fast local gate does not
silently pass by skipping persistence coverage.

The CI `Security checks` workflow additionally builds the worker images, creates
SPDX SBOMs, scans them with Trivy, performs migration-backed tests, and runs the
Codex isolation and Claude composite-worker acceptance suites. A release uses
that workflow's artifacts for the exact commit being released.

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

### Coding worker toolchains — live confirmation (2026-09-11)

Confirms the `node-python` toolchain (branch `worktree-coding-worker-toolchains`,
design/plan in `docs/private/2026-09-10-coding-worker-toolchains-*.md`):
`phase5-local-smoke`'s profile was updated to
`toolchain: "node-python"`, `toolchainVersion: "3.12"` via `update_agent`,
with `CODING_WORKER_IMAGE_NODE_PYTHON_3_12` pointing at the
`Dockerfile.node-python` build, then the same hello.py task re-triggered.

- **Run ID:** `cmtwuk0du0002sqx12my5fz1f`
- **Date:** 2026-09-11 11:02 UTC
- **Outcome:** `failed` (`coding_failure_executor`), $0 cost (failed before
  any LLM call). The launched container (`reevo-keeper-cb463d11d1d9632daef3`)
  exited 133 (SIGABRT) with no log output. Confirmed **not** a toolchain-
  resolution bug: `docker inspect` showed it launched with the correct
  `sha256:9326...cded9` (node-python) image digest — the new
  `resolveCodingWorkerImage`/dispatch-snapshot path worked correctly.
  Reproducing the same resource/security constraints (`--memory`,
  `--pids-limit=16`, `--network=none`, `--read-only`, seccomp) via a plain
  `docker run` did not reproduce the crash — treated as a transient
  container-start flake (this same Docker host was running a dozen+
  unrelated long-lived containers at the time), not a defect in this
  feature. Left uncleaned container removed manually afterward — worth a
  follow-up look if it recurs (terminal-failure cleanup may have a gap for
  an abrupt SIGABRT specifically).
- **Retry — Run ID:** `cmtwun2gw0004sqx1kac1dzne`
- **Date:** 2026-09-11 11:04 UTC
- **Outcome:** `pull_request_opened` — [PR #3](https://github.com/chfields/reevo-run/pull/3),
  commit `50dbf79b83c7170a67fc2aa359d88144d8894e5d`.
- **Cost:** $0.006638 (53,931 input / 1,026 output tokens).
- **Verification — this is the actual capability being confirmed:** the
  worker's own runtime check now reports
  `{"command": "python3 hello.py", "outcome": "passed"}` — not `skipped`,
  as the 2026-09-09 run above recorded. `python3` is present and the
  written program actually executes and is verified inside the container.
- **Cleanup:** PR #3 closed, branch deleted from `origin`, immediately
  after review.

### `node-python` worker image gained real Python TDD support (2026-09-12)

A full ground-up capability test (design a project from an empty repo, TDD
build, test, PR) surfaced that `node-python` only ever added bare `python3` —
no `pip`, no `pytest`. A `coding` agent asked to follow TDD wrote a real
pytest suite but couldn't execute it inside its own sandbox
(`{"command": "pytest -q", "outcome": "failed"}`, reason: pytest not found),
falling back to `compileall` + manual checks. Verified independently outside
the sandbox that the agent's actual code and tests were correct (11/11
passed) — this was a toolchain gap, not an agent defect.

Fixed in `Dockerfile.node-python`: install `python3-pip`, pin and install
`pytest==8.3.4`, then `apt-get purge -y --auto-remove python3-pip` — pip's
own files are apt-tracked and get removed, but pytest's files (installed by
pip, not apt) are untouched. Added `pip`/`pip3` to the existing
binary-absence hardening assertion, alongside a build-time check that
`python3 -m pytest --version` still works after the purge. Verified locally:
built the image, ran `import pytest` and `python3 -m pytest -q` against a
real test file inside the hardened, non-root container — passed. `pip`/`pip3`
confirmed absent at runtime, consistent with the existing curl/wget/ssh/
docker/sudo/gcc/make hardening (no network-fetch-and-execute vector left
inside the sandbox).

### Claude Code live confirmation (2026-09-12)

- **Run ID:** `cmtyjdclo0001sqreyrmd4jjt`
- **Agent:** `claude-phase5-live-smoke-1789224280679` (`claude-sonnet-5`,
  provider `claude-code`, budget $0.25)
- **Task:** create exactly one file, `claude-phase5-smoke.md`, containing one
  specified line and a trailing newline.
- **Outcome:** draft [PR #16](https://github.com/chfields/reevo-run/pull/16),
  commit `d552b2c70cc4317a31607c29b3f281f28e82cffe`.
- **Cost:** $0.008709 (2,605 input / 444 output tokens).
- **Verification:** the pull-request diff contained exactly the requested file,
  line, and trailing newline.
- **Cleanup:** PR #16 was closed without merging, its generated branch was
  deleted, and the run's worker resources were removed.
- **Protocol correction:** PR #17 preserves the exact reviewed Anthropic beta
  allowlist and header fingerprint, supports the SDK's reviewed tool loop and
  string-form system prompt, and rejects unsupported requests before resolving
  the provider credential.

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

Phase 5 supports Codex and Claude Code through protocol-specific routes on the
trusted budget proxy, GitHub App checkout and draft-PR finalization, and the
Docker JobLauncher. It does not support GitLab or Bitbucket, Bedrock or Vertex
Claude coding credentials, Fargate, GitHub Actions as a launcher, auto-merge,
owner-approved workflow-file editing, PR update loops, or guaranteed test
success. DBOS durable execution is implemented separately in Phase 6; it does
not resume an in-flight isolated coding job.

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
