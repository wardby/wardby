---
id: errors/service-declaration-invalid
title: Service declaration invalid
summary: Wardby refused the coding run because the repository's .wardby/services.yaml on the base branch is not a valid declaration.
audience: operator
tags: [error, coding-agents, services, refusal]
appliesTo: >=0.2.1
---

# Service declaration invalid

`service_declaration_invalid` means the repository's `.wardby/services.yaml`,
read from the run's base branch, could not be used. The run's `error` names the
line and reason. Wardby refuses the run before a coding worker starts.

1. Check the file on the base branch. Its keys are `services` and
   `toolchain`, each at most once, mapping catalog names (lowercase letters,
   digits and hyphens) to quoted version strings, for example
   `postgres: "16"`. `toolchain:` takes exactly one entry, and each entry must
   sit under the key of its catalog kind: "`<name>` is a toolchain; declare it
   under `toolchain:`" means a toolchain was listed under `services:` (see
   [toolchains](../coding-toolchain.md)).
   A `setup:` key lists [setup jobs](../coding-setup-jobs.md); "`<job>` needs
   `<service>`; declare it under `services:`" means a setup job's `waitFor`
   service isn't declared in the same file.
2. Keep it to at most five entries and under 8 KiB. Images, ports, commands
   and environment belong in the catalog, not in the repository.
3. Merge the fix to the base branch; a fix on the run's own branch has no
   effect.
4. Trigger a new run; a refused run is not resumed automatically.

The same code is used when the declared services' instructions would push the
coding task over its size limit; declare fewer services in that case. See
[Coding services](../coding-services.md).
