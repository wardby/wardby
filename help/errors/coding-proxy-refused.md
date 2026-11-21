---
id: errors/coding-proxy-refused
title: A coding run failed because the coding proxy refused its request
summary: The run failed with coding_failure_proxy_refused because the coding proxy refused one of its model requests, for example a tool it does not allow.
audience: operator
tags: [error, coding-agents, coding proxy, coding_failure_proxy_refused, tools_not_allowed, claude-code]
appliesTo: ">=0.10.2"
---

# A coding run failed because the coding proxy refused its request

## What happened

The run's error starts with `coding_failure_proxy_refused`, followed by a
diagnostic id. Every model request of a coding run goes through the coding
proxy, which allows only the request shapes Wardby expects: its own tools, the
agent's attached MCP tools, and the features the run's model supports. The proxy
refused one of this run's requests, and the coding agent stopped.

The control plane's log has one `coding.proxy_refused` line for the run with the
proxy's code, for example `tools_not_allowed` (the request offered a tool the
proxy does not accept for this run) or `model_not_allowed` (a model other than
the run's). The code never includes the request itself.

## What to do

- Read the `coding.proxy_refused` line for the code.
- `tools_not_allowed` usually means the coding agent offered a tool that this
  version of Wardby's proxy does not accept for the run. Check that the control
  plane, coding proxy and worker images are the same Wardby version.
- If the versions match, report the code and the agent's settings (provider,
  `claudeBareMode`, `repoSkills`, `workflow`) as a bug.

## See also

- [Run a Claude Code workflow script](../coding-workflows.md)
- [Repository instructions and skills](../repo-instructions-and-skills.md)
