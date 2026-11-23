---
id: errors/agent-prompt-version-conflict
title: Agent prompt version conflict (agent_prompt_version_conflict)
summary: The agent's prompt changed since you listed its versions.
audience: operator
tags: [error, agents, agent prompt, agent_prompt_version_conflict]
appliesTo: ">=0.10.2"
---

# Agent prompt version conflict

`agent_prompt_version_conflict` (HTTP 409). `restore_agent_prompt_version` needs `baseNumber`, the latest version you saw. The prompt changed after that (another `update_agent` or restore), so nothing was changed. Call `list_agent_prompt_versions` again, check the newest version, and retry with its number.

See [Agent prompt history and rollback](../agent-prompt-history.md).
