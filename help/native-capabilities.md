---
id: native-capabilities
title: Use native agents, tools, and data
summary: Attach scoped tools, secrets, datastores, memory, schedules, and sub-agents to a native Wardby agent.
audience: developer
tags: [agents, tools, secrets, datastores, memory, schedules, subagents, zod, paramsZod, create_tool, dry_run_tool]
appliesTo: >=0.2.1
---

# Use native agents, tools, and data

Native agents work through the Wardby control plane rather than a repository
checkout. Give each agent only the capabilities its job needs:

- **Tools** for approved external actions or APIs.
- **Secrets** as bindings to tools or agents; values remain in Wardby's trusted
  components rather than being returned through MCP.
- **Datastores** for scoped application data and queries.
- **Memory** for agent-owned durable context.
- **Schedules and webhooks** to start event-driven work.
- **Sub-agents** for delegated, bounded work with their own capability set.

A tool's parameters are a Zod schema written as source text (`paramsZod` on
`create_tool` and `update_tool`). Wardby compiles it inside the sandbox, both to
derive the JSON Schema the model sees and to validate each call's arguments.

Wardby itself now uses Zod 4. For this release only, a tool's `paramsZod` is
still compiled with Zod 3 (Zod 4's built-in `zod/v3` API), so existing tools keep
working unchanged; a schema Zod 3 can't compile, such as one using `z.email()`,
is compiled with Zod 4. **Zod 3 schemas stop working in the next release**,
which compiles `paramsZod` with Zod 4 only. A schema that calls something Zod 4
removed, such as `.nonstrict()`, `.deepPartial()`, `z.ostring()` or
`z.string().ip()`, will then fail every call's validation.

Wardby warns about each such tool now:

- `create_tool`, `update_tool` and `dry_run_tool` results include a `warnings`
  list naming the tool and the removed methods;
- `wardby tool create` and bundle imports print the same warning;
- the server logs one warning per affected tool at startup.

To check a schema before the next release, call `dry_run_tool` with the tool's
`paramsZod` and sample arguments. With no `warnings` in the result, the schema
compiles with Zod 4 and Zod 4 treats those arguments the same way. Otherwise,
rewrite the schema with the Zod 4 API (for example `z.looseObject()` for
`.nonstrict()`, `z.string().optional()` for `z.ostring()`, and `z.ipv4()` or
`z.ipv6()` for `.ip()`), dry-run it again, and save it with `update_tool`.

Use a budget or shared budget group on every agent, and inspect runs before
expanding its access. An access grant is intentional delegation: use it only
when an owner permits one agent to use another resource. Creating or changing
tools, secrets, datastores, schedules, webhooks, memory, and budget groups
requires the matching MCP scope.

See [Operate agents](operating-agents.md) for run and budget management, and
[`README.md`](../README.md) for the feature overview and MCP operations.
