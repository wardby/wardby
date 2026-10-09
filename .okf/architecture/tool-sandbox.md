---
type: Architecture Pattern
title: Tool sandbox
description: Agent tools run in a QuickJS (WASM) isolate with host allowlists, secret bindings and param validation.
tags: [sandbox, security, tools]
generated:
  by: claude-code/claude-sonnet-5-5
  at: 2026-10-09T17:00:00Z
sources:
  - id: readme
    resource: /README.md
  - id: sandbox-dir
    resource: /src/sandbox
---

# Behavior

Tools run in QuickJS isolation with host allowlists and secret
bindings.[^readme] Code is in `src/sandbox/`[^sandbox-dir]:

* `run-in-sandbox.ts` - entry used by the [runner](/architecture/runner-and-engine.md)
* `zod-params.ts` - parameter validation inside the sandbox
* `fetch-policy.ts`, `safe-fetch.ts` - outbound HTTP allowlisting
* `tool-capabilities.ts` - declared capabilities (hosts, secrets, datastores)
* `limits.ts`, `bounded-json.ts` - resource and output bounds
* `pii-redaction.ts`

Tool output is untrusted content (`src/core/untrusted-content.ts`).

[^readme]: Project README
[^sandbox-dir]: src/sandbox
