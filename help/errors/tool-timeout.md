---
id: errors/tool-timeout
title: A tool call ran out of time (timeout, fetch_cancelled_or_timeout)
summary: A sandboxed tool call hit its time limit; raise the tool's timeoutMs, up to the server's WARDBY_TOOL_MAX_TIMEOUT_MS.
audience: developer
tags: [timeout, timeoutMs, wall-time, fetch_cancelled_or_timeout, sleep_limit, WARDBY_TOOL_MAX_TIMEOUT_MS]
appliesTo: ">=0.8.0"
---

# A tool call ran out of time

## What happened

A tool's result was `{"error":"timeout","message":"Exceeded the 10000ms wall-time limit. ..."}`.
The call ran longer than the tool's time limit, so it was stopped. The run goes on: only this call
failed. The message names the limit. Without `timeoutMs` a tool has 10 seconds.

Related results:

- `fetch_cancelled_or_timeout` from inside the tool: a `fetch` was aborted because the call ran
  out of time or the run stopped.
- `sleep_limit`: the tool asked to wait longer than its own limit.
- `{"error":"cancelled"}`: the run was stopped while the call was running.

## What to do

1. Check how long the API the tool calls really takes.
2. Give the tool a longer limit with `update_tool` (`timeoutMs`, in milliseconds), or
   `wardby tool update <tool> --timeout-ms <ms>`.
3. Test it with `dry_run_tool` and the same `timeoutMs`.

`timeoutMs` can't exceed the server's `WARDBY_TOOL_MAX_TIMEOUT_MS` (default `300000`); a larger
value is refused with an error naming the ceiling. If you need more, ask the operator to raise it.
If the operator lowers the ceiling, a tool with a larger `timeoutMs` runs with the ceiling.

Runs that started before the change keep the limit they loaded; the next run uses the new one.

See [Use native agents, tools, and data](../native-capabilities.md#tool-time-limits).
