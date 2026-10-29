---
id: errors/secret-in-value
title: A value was not stored because it contains a secret (secret_in_value)
summary: A datastore or agent memory write was refused because the value contains the value of a secret attached to the agent; store the secret's name and read it when needed.
audience: operator
tags: [error, secrets, datastore, memory, secret_in_value, secret_check_unavailable, datastore set, memory set]
appliesTo: ">=0.7.0"
---

# A value was not stored because it contains a secret (secret_in_value)

`secret_in_value` means a write to a datastore or agent memory contained the
value of a secret attached to the agent, in the value or in the key. The write
came from a tool's `datastore.set` (or a shared datastore's `set`), from the
`memory_set` tool, from the `datastore_set` or `set_agent_memory` MCP tools, or
from a bundle import. The error names the secret. Nothing was stored.

Secret values are never stored in datastores or agent memory, because anything
stored there can be read back by other tools and later runs that were never
given the secret, and can be printed.

## What to do

Store the secret's **name**, not its value, and read the secret when you need it:

- `secrets.get("NAME")` in a tool that is allowed to read the secret, or
- `fetch(url, { secrets: ["NAME"] })` for a brokered secret.

See [Secrets and tools](../../docs/tool-secrets.md#secret-values-are-never-stored).

## `secret_check_unavailable`

The agent's secrets could not be read, so the value could not be checked and was
not stored. Try the write again. If it keeps happening, check the database
connection and the secret encryption configuration on the server.

## Bundle imports

A seeded datastore entry in an imported bundle, per-agent or shared, whose key
or value contains an attached secret's value is skipped, and the import reports
a warning that names the secret (the entry's key is withheld from the warning).
The rest of the bundle is still imported.

## Also masked

Secret values are also kept out of other output:

- A native run's final text and error have attached secret values replaced with
  `[REDACTED]`.
- The task text of a `delegate_to_*` call has the delegating agent's attached
  secret values replaced with `[REDACTED]` before the sub-agent's run is created.
- Comments, reviews, and Jira posts made through built-in tools have attached
  secret values replaced with `[REDACTED]`.
- If the secrets cannot be read when a run ends, both its stored final text and
  its stored error are
  `[withheld: this text could not be checked for secret values]`.
- If the secrets cannot be read when a posting tool or a `delegate_to_*` call
  runs, the tool returns `secret_check_unavailable` and posts nothing or creates
  no sub-agent run.

## Limits

Matching is by exact value, including its JSON-escaped forms and, for brokered
secrets, the encoded forms that the broker scrubs. Values shorter than 6
characters are not matched. A value that is split, re-encoded, or otherwise
transformed is not detected. Values stored before this check existed are not
scanned.

See also [Brokered secrets](../brokered-secrets.md).
