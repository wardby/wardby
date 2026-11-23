---
id: agent-prompt-history
title: Agent prompt history and rollback
summary: Every change to an agent's system prompt is kept as a numbered version; list, read and restore an earlier prompt with list_agent_prompt_versions, get_agent_prompt_version and restore_agent_prompt_version.
audience: operator
tags:
  [
    agent prompt,
    system prompt,
    prompt history,
    versions,
    rollback,
    roll back,
    restore,
    update_agent,
    promptSummary,
    list_agent_prompt_versions,
    get_agent_prompt_version,
    restore_agent_prompt_version,
  ]
appliesTo: ">=0.10.2"
---

# Agent prompt history and rollback

If an edit to an agent's system prompt made it worse, you can see what it said before and put it back. Wardby keeps every distinct prompt an agent has had as a numbered, unchangeable version. The newest version always equals the agent's live prompt.

## What is recorded

A version is added whenever the prompt text changes: `create_agent`, `update_agent` with a new `systemPrompt`, a restore, the CLI, an import that creates the agent, and quickstart seeding. Saving the same text again adds nothing. Agents that existed before this feature start at version 1 (`via: backfill`). Only the system prompt is versioned, not the model, budget or schedule.

Add `promptSummary` (1 to 200 characters) to an `update_agent` call that changes `systemPrompt` to label the version, for example "Tighten the output format".

## Roll back a bad prompt

1. Call `list_agent_prompt_versions` with the `agentId`. It returns each version's `number`, `via`, `createdById`, `summary`, size and time, newest first (`limit` defaults to 50, at most 200). It never returns the text.
2. Call `get_agent_prompt_version` with `agentId` and `versionNumber` to read one. The text is in `systemPromptText`, with the agent's secret values masked.
3. Call `restore_agent_prompt_version` with `agentId`, `versionNumber`, and `baseNumber`, the latest version number you saw. The old text becomes the live prompt and a new version with the summary "Restored v<N>". Nothing is deleted. The reply holds numbers only.

Listing and reading need read access to the agent; restoring needs write access. A coding agent's retained warm sandboxes are ended when the restore changes its prompt, as with `update_agent`.

## Things to know

- The stored text is exactly what ran, including any secret values pasted into it. Reading masks them; restore copies the stored text, so a restored prompt works as it did.
- History has no retention limit and is deleted with the agent.
- Runs do not record which version they used.

## Errors

- [Prompt version not found](errors/agent-prompt-version-not-found.md)
- [Prompt version conflict](errors/agent-prompt-version-conflict.md)
- [Prompt version is the live prompt](errors/agent-prompt-version-is-latest.md)

See also [Operate managed agents](operating-agents.md) and [Connect a client to Wardby](mcp.md).
