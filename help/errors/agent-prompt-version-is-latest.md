---
id: errors/agent-prompt-version-is-latest
title: Agent prompt version is the live prompt (agent_prompt_version_is_latest)
summary: The chosen version already is the agent's live prompt.
audience: operator
tags: [error, agents, agent prompt, agent_prompt_version_is_latest]
appliesTo: ">=0.10.2"
---

# Agent prompt version is the live prompt

`agent_prompt_version_is_latest` (HTTP 409). You picked the newest version, or one whose text equals the live prompt, so there is nothing to restore. Pick an older version from `list_agent_prompt_versions`.

See [Agent prompt history and rollback](../agent-prompt-history.md).
