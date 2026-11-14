---
id: errors/substrate-collect-timeout
title: The Substrate tool side never reported the workspace (substrate_collect_timeout)
summary: A coding run on the experimental Substrate launcher failed because the agent finished but the tool side did not upload the workspace within SUBSTRATE_COLLECT_GRACE_SEC.
audience: operator
tags: [error, substrate, substrate_collect_timeout, job launcher, coding-agents, workspace, SUBSTRATE_WORKSPACE_MAX_MB]
appliesTo: ">=0.9.15"
---

# The Substrate tool side never reported the workspace

`substrate_collect_timeout` (logged as `job_substrate_collect_timeout`) means
the agent finished, but the tool actor did not finish uploading the workspace
within `SUBSTRATE_COLLECT_GRACE_SEC` (120 seconds by default) after the agent's
exit. The actors are deleted and the run fails; its changes are not collected.

1. Check the proxy's `substrate.diagnostics` warnings for the run: a tail from
   the tool bridge usually says why it stopped.
2. If the workspace is large, check `SUBSTRATE_WORKSPACE_MAX_MB` on the proxy
   (1024 by default). A `gitHistory` run uploads the whole `.git`, so a long
   history can exceed it. The proxy refuses an upload over the limit.
3. If the upload is just slow, raise `SUBSTRATE_COLLECT_GRACE_SEC` (10 to 3600).
4. Check the egress gateway and the proxy are healthy, as for
   [substrate_startup_timeout](substrate-startup-timeout.md).

See [Run coding agents on Substrate](../job-launcher-substrate.md) and the
[Substrate backend guide](../../docs/substrate-backend.md).
