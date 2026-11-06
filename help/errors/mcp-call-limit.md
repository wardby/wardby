---
id: errors/mcp-call-limit
title: A coding run used up its remote tool calls (mcp_call_limit)
summary: A Claude Code or Codex run made more remote MCP tool calls than WARDBY_MCP_MAX_CALLS_PER_RUN allows, so further calls are refused.
audience: operator
tags: [mcp, mcp_call_limit, WARDBY_MCP_MAX_CALLS_PER_RUN, coding agent, claude code, codex, call limit]
appliesTo: ">=0.8.0"
---

# A coding run used up its remote tool calls

## What happened

A call to a remote MCP tool returned `mcp_call_limit`. Each coding run (Claude Code or Codex) may make a fixed number of remote MCP tool calls, `100` by default. Every call counts, including calls that failed or timed out. Once the run reaches the limit, further calls are refused; the agent sees the refusal as the tool's result and the run goes on.

## What to do

1. Check whether the agent is looping on a tool, for example retrying a call that keeps failing. Fix the cause, or tighten the agent's instructions.
2. If the run really needs more calls, ask the operator to raise `WARDBY_MCP_MAX_CALLS_PER_RUN` on the native gateway, which counts the calls, and on the server so both agree (a positive whole number; any other value stops start-up). Restart them to apply it.
3. Native agents are not limited by this setting.

See [Remote MCP servers](../mcp-servers.md) and [Remote MCP servers for coding agents](../../docs/mcp-servers.md#coding-agents).
