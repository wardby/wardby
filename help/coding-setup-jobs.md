---
id: coding-setup-jobs
title: Run migrations or seed data before a coding agent starts (setup jobs)
summary: Register a setup job (kind setup) in the service catalog and list it under setup in .wardby/services.yaml; Wardby runs it from the run's checkout after the services are ready and before the agent starts, and fails the run if it fails.
audience: operator
tags: [setup, migrations, seed data, services.yaml, setup jobs, liquibase, flyway, alembic, kubernetes, docker]
appliesTo: ">=0.10.2"
---

# Run migrations or seed data before a coding agent starts (setup jobs)

A **setup job** is a one-off step a run's tests need before they can pass:
database migrations, search-index mappings, seed data. Wardby runs it after
every declared service is ready and before the agent starts, on the Kubernetes
and Docker job launchers, for Claude Code and Codex agents. The Substrate
launcher refuses setup jobs.

1. **Register it** with `create_service`, `kind: "setup"`, pinned by digest:
   an `image` (your migration tool's, or your team's), the `command` to run,
   `waitFor` (the services it needs), throwaway `serviceEnv` (for example the
   database entry's root password), `resources` (at least 1 GiB of memory for
   JVM tools), `writablePaths` (such as `/tmp`) and `timeoutSeconds` (default
   600).
2. **Declare it** in `.wardby/services.yaml`, after the services it needs:

   ```yaml
   services:
     mysql: "8"
   setup:
     app-migrations: "1"
   ```

   Jobs run one at a time, in this order, at most 4 per run.

3. **Allow it** on the agent: add its name to `codingProfile.services`.

The job runs in `/workspace`, the run's checkout, mounted read-only, so it
reads the branch's own migrations. It has no network beyond the run's services:
turn off any update or version check the tool makes, or it hangs until the
timeout.

If the job fails, the run fails with
[`coding_setup_failed`](errors/setup-failed.md) before the agent starts. Its
output stays in the operator log, redacted.

The full field list and examples are in
[`docs/coding-services.md`](../docs/coding-services.md#preparing-services-before-the-agent-starts-setup-jobs).
See also [Give coding runs the services their tests need](coding-services.md).
