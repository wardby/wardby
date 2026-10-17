---
id: errors/native-sandbox-launch-abandoned
title: Native worker launch abandoned
summary: A sandbox run ended while its worker was launching (usually stopped during a low-power gateway wake), so no worker pod was created.
audience: operator
tags: [error, native-agents, sandbox, kubernetes, low-power, native_sandbox_launch_abandoned]
appliesTo: ">=0.6.1"
---

# Native worker launch abandoned

`native_sandbox_launch_abandoned` means a sandbox run ended while its worker was being launched, so Wardby did not create the worker pod. Most often the run was stopped (`stop_run`, or its parent run was cancelled) while the native gateway was waking in low-power mode, which can take a few minutes on a cold node.

The run already has its own final status, such as `cancelled`. This code only appears in the control-plane log, as the reason the launch stopped. Nothing is left to clean up.

1. If the run was stopped on purpose, there is nothing to do.
2. If you did not stop it, check the run with `get_run`: its status and error say what ended it.
3. Trigger the run again if you still want it.

See [Low-power mode](../low-power-mode.md) and the
[native sandbox guide](../../docs/native-sandbox.md).
