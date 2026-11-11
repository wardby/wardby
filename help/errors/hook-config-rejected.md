---
id: errors/hook-config-rejected
title: A run hook was refused (hook_config_rejected, hook_config_has_secret, final_text_needs_admin)
summary: create_run_hook or update_run_hook refused the hook; fix the config, move secrets to allowedSecrets, or ask an admin.
audience: operator
tags: [hooks, run hook, hook_config_rejected, hook_config_has_secret, final_text_needs_admin, create_run_hook]
appliesTo: ">=0.9.8"
---

# A run hook was refused

## What happened

`create_run_hook` or `update_run_hook` returned an error:

- `hook_config_rejected` — the tool's `paramsZod` rejects `{ event, config }`
  for one of the events the hook takes. The message names the event kind and
  the schema's complaint.
- `hook_config_has_secret` — `config` holds the value of one of the agent's
  secrets. `config` is plain settings and is shown back by `list_run_hooks`.
- `final_text_needs_admin` — `includeFinalText` sends the run's own output out
  of wardby, so turning it on needs `agents:admin` with the admin role.

## What to do

1. `hook_config_rejected`: make the schema accept the event envelope (a loose
   `z.object({ event: z.object({ kind: z.string() }).passthrough(), config: … })`
   is enough), or change `config` to match it.
2. `hook_config_has_secret`: remove the value from `config`, list the secret
   in `allowedSecrets`, and read it in the tool with `secrets.get(name)`.
3. `final_text_needs_admin`: ask an admin to create or update the hook, or
   leave `includeFinalText` off.

See [Run hooks](../run-hooks.md).
