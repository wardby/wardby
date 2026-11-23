---
id: errors/setup-failed
title: A setup job failed
summary: The coding run failed before its agent started because a setup job (migrations, seed data) from .wardby/services.yaml exited non-zero, timed out or could not start.
audience: operator
tags: [error, coding-agents, services, setup, migrations, setup jobs, coding_setup_failed]
appliesTo: ">=0.10.2"
---

# A setup job failed

`coding_setup_failed:<name>` (failure category `service_setup`) means a
[setup job](../coding-setup-jobs.md) the repository declares did not finish
with exit 0, so Wardby stopped the run before its agent started. The run's
status says "The `<name>` setup job failed, so the run didn't start." No model
was called.

The job's output never reaches the run. An operator finds a redacted tail of
it in the control plane's log, on the line for `coding.setup_failed` (Docker)
or `coding_setup_failed:<name>` (Kubernetes), with the job's exit code. Exit
124 means it ran past its `timeoutSeconds`; 127 means its command could not be
started.

Common causes:

1. **The migrations themselves fail** on the branch: fix them, or run them
   locally against the same service version.
2. **The tool calls out.** The run has no network beyond its services, so an
   update or version check hangs until the timeout (exit 124). Turn it off in
   the job's command or configuration.
3. **It runs out of memory.** JVM tools need at least 1 GiB in `resources`.
4. **It writes outside `writablePaths`** (the root filesystem is read-only):
   add the directory, such as `/tmp`.
5. **Wrong credentials or database name** in its `serviceEnv`: use the
   service entry's throwaway values.

Fix the catalog entry with `update_service`, or the repository, then trigger a
new run. See [Coding services](../coding-services.md).
