---
id: errors/substrate-collect-timeout
title: The Substrate tool side never reported the workspace (substrate_collect_timeout)
summary: A coding run on the experimental Substrate launcher failed because the worker exited without a result and the tool side then neither uploaded the workspace nor reported a failure within SUBSTRATE_COLLECT_GRACE_SEC.
audience: operator
tags: [error, substrate, substrate_collect_timeout, job launcher, coding-agents, workspace, SUBSTRATE_WORKSPACE_MAX_MB]
appliesTo: ">=0.9.15"
---

# The Substrate tool side never reported the workspace

`substrate_collect_timeout` (logged as `job_substrate_collect_timeout`) means
the worker exited without a usable result, and the tool actor did not finish
uploading the workspace, or report that it could not, within
`SUBSTRATE_COLLECT_GRACE_SEC` (120 seconds by default) after that exit. The
actors are deleted and the run fails; its changes are not collected. (After a
worker that did report a result, the workspace may take until the run's
deadline.)

A workspace over the proxy's `SUBSTRATE_WORKSPACE_MAX_MB` is not this error:
the tool side reports it, and the run fails at once with
[substrate_collect_failed](substrate-collect-failed.md). A collect timeout means
the tool side went quiet:

1. The tool actor stopped or lost its connection to the proxy while archiving or
   uploading. The tool bridge sends no error output to the proxy; its events
   are in the tool actor's own output, and the proxy's route log shows the
   run's last tool requests.
2. If the upload is just slow (a large workspace, a `gitHistory` run's whole
   `.git`), raise `SUBSTRATE_COLLECT_GRACE_SEC` (10 to 3600).
3. Check the egress gateway and the proxy are healthy, as for
   [substrate_startup_timeout](substrate-startup-timeout.md).

See [Run coding agents on Substrate](../job-launcher-substrate.md) and the
[Substrate backend guide](../../docs/substrate-backend.md).
