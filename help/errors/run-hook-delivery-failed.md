---
id: errors/run-hook-delivery-failed
title: A run hook delivery failed (hook_params_rejected, hook_disabled, secret_values_unavailable)
summary: A run hook's tool could not be called or threw; read lastError in list_run_hooks and fix the tool, its schema or the hook.
audience: operator
tags: [hooks, run hook, hook_params_rejected, hook_disabled, secret_values_unavailable, list_run_hooks]
appliesTo: ">=0.9.8"
---

# A run hook delivery failed

## What happened

`list_run_hooks` shows a `lastError` or a failed count on a hook. Each delivery
is retried with backoff up to 10 times; the hook's `lastError` is the error
that made one fail for good.

- `hook_params_rejected` — the event and the hook's `config` don't pass the
  tool's `paramsZod`, usually because the tool changed since the hook was
  created. Not retried.
- `hook_disabled` — the hook was turned off before the event was delivered.
  Not retried.
- `secret_values_unavailable` — wardby couldn't read the agent's secret values
  to mask the delivery, so it waits rather than send unmasked text. Retried.
- `thrown: …`, `timeout: …` — the tool itself threw or ran out of time (for
  example the destination API answered with an error). Retried.

## What to do

1. Run `test_run_hook` on the hook to see the error now.
2. For `hook_params_rejected`, fix the tool's `paramsZod` or the hook's
   `config`, then `update_run_hook`.
3. For tool errors, check the destination (a Slack bot not in the channel, a
   wrong API key) and the hook's `allowedHosts` and `allowedSecrets`. If
   `capabilitiesGranted` is false, the agent's owner must re-grant them with
   `update_run_hook`.
4. `update_run_hook` clears `lastError`. Failed deliveries are not resent.

See [Run hooks](../run-hooks.md).
