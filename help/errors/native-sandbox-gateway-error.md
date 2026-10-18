---
id: errors/native-sandbox-gateway-error
title: Native worker's gateway call failed
summary: The sandbox worker's call to the gateway failed with an error the run could not continue from.
audience: operator
tags: [error, native-agents, sandbox, native_sandbox_gateway_error]
appliesTo: ">=0.5.4"
---

# Native worker's gateway call failed

`native_sandbox_gateway_error: <code>: <message>` means the sandbox worker called the gateway (a model turn, a tool, or a delegation) and got an error the run could not continue from. The worker reports the run failed with this error instead of exiting, so it is not `native_sandbox_worker_exited`.

1. Read the code and message in the run's error (`get_run`).
2. For the gateway's `internal` code the message is never recorded. When the gateway's error named one of wardby's own declared codes, that code follows (any other leading word, and any code that matches a secret value the run can read, never leaves the gateway), for example `native_sandbox_gateway_error: internal: coding_execution_not_configured` (the gateway that served the call cannot start coding runs); otherwise the error is `native_sandbox_gateway_error: internal`. Read the gateway's logs (`native gateway request failed`) for the details: the line carries the error's message and stack with the run's secret values replaced by `[REDACTED]`; when the gateway does not know the run's secret values (or the run has none), or the failure was not an error object, it carries only the error's name (`errName`) and declared code (`causeCode`).
3. Fix the cause the message names, or check that the gateway can reach the database and the LLM provider.
4. Trigger the run again.

See [Run native agents in a sandbox](../native-sandbox.md) and the
[native sandbox guide](../../docs/native-sandbox.md).
