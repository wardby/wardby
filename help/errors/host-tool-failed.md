---
id: errors/host-tool-failed
title: A host provider tool failed (host_tool_*, host_*)
summary: test_host_provider reports a fixed code for each failed operation; a tool's own message is dropped on purpose, so test the tool with dry_run_tool.
audience: operator
tags: [host_tool_failed, host_tool_timeout, host_tool_request_denied, host_tool_no_credential, host_forbidden]
appliesTo: >=0.8.0
---

# A host provider tool failed

## What happened

A tool's own text never reaches a report, a model or a comment, in case it holds something
private. So `test_host_provider` gives a fixed code for each operation.

## What to do

- `host_unauthorized` or `host_forbidden`: the host refused the credential. Check the token and
  its scopes. On the permission lookup, a repository token is often not enough.
- `host_not_found`, `host_conflict`, `host_rate_limited` or `host_unavailable`: the host answered
  with that state. Check the repository, pull request or ref you named, or try again later.
- `host_tool_no_credential`: no `credentials` entry covers this repository.
- `host_tool_request_denied`: the tool left its API hosts or repository path, used the wrong
  method, set a header other than `accept`, `content-type`, `if-match` or `if-none-match`, sent a
  path a server could read as something else (dot-only segments, encoded separators), or made
  more than three requests. No request follows a redirect: fetch the `Location` yourself.
- `host_tool_invalid_result` or `host_tool_invalid_params`: the tool doesn't match its
  operation's shape.
- `host_tool_failed`: the tool threw an error. Run its code with `dry_run_tool` to see why.
- `host_tool_timeout`: it ran out of time or instructions.

To fix a tool, call `update_tool`, then `approve_host_provider_tools`.

See [Host providers](../host-providers.md).
