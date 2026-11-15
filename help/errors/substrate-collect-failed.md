---
id: errors/substrate-collect-failed
title: The Substrate tool side could not deliver the workspace (substrate_collect_failed)
summary: A coding run on the experimental Substrate launcher failed because the tool actor reported that it could not set up, archive or upload the workspace, for example a workspace over SUBSTRATE_WORKSPACE_MAX_MB.
audience: operator
tags: [error, substrate, substrate_collect_failed, job launcher, coding-agents, workspace, SUBSTRATE_WORKSPACE_MAX_MB]
appliesTo: ">=0.9.15"
---

# The Substrate tool side could not deliver the workspace

`substrate_collect_failed` (logged as `job_substrate_collect_failed`) means the
run's tool actor told the coding proxy that it could not produce the workspace,
so the run failed without collecting its changes. The run's exit code is the
worker's, when the worker reported one.

The tool actor reports this when:

- **the workspace is over the proxy's limit.** The proxy refuses a workspace
  upload larger than `SUBSTRATE_WORKSPACE_MAX_MB` (1024 by default). Raise it
  on the coding proxy, or keep large build output out of the workspace with the
  agent's collect exclusions. A `gitHistory` run uploads only its result bundle
  from `.git`, never the repository's history, so history size is not the
  cause;
- **the upload failed** after its retries, or the proxy refused it for another
  reason (check the proxy is healthy and the blob store is writable);
- **archiving the workspace failed** (`tar` exited with an error);
- **a `gitHistory` run's result bundle could not be trusted:** it is not a
  regular file (a symlink, a FIFO), or the root `.git` was swapped while the
  bundle was read. The agent's commits are not collected. A bundle over the
  run's limit fails with `vcs_result_bundle_too_large` instead;
- **the tool side never started:** it could not fetch its setup or the workspace
  seed, the seed was refused as unsafe, or the tool runner did not start. The
  run then fails at once instead of waiting for
  [substrate_startup_timeout](substrate-startup-timeout.md).

The tool bridge sends no error output to the proxy (the tool actor runs the
agent's commands); its own events and the tool runner's error output stay in the
tool actor's output. The proxy's route log shows which upload was refused and
with which status.

See [Run coding agents on Substrate](../job-launcher-substrate.md) and the
[Substrate backend guide](../../docs/substrate-backend.md).
