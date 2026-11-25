---
id: native-agent-documents
title: Documents from native agents
summary: Turn on documentTools for a native agent so a run can list, read, create and revise Wardby documents and designs with doc_* tools, reply to comment threads and submit for review, within the access you give it.
audience: operator
tags: [documents, designs, native-agents, doc_create, documentTools, doc_get, doc_publish_version, maxNewPerRun]
appliesTo: ">=0.10.2"
---

# Documents from native agents

A native agent with the `documentTools` setting gets built-in `doc_*` tools in
its runs. They read and write [documents and designs](documents.md) as the
agent itself, never as its owner, and never go through the sandbox. A coding
agent does not take the setting; it works on a document through its repository
([Send comment threads to a coding agent](comment-threads-and-agents.md)).

## Turn it on

Set it with `update_agent` (or `create_agent`) on a native agent you own:

```json
{
  "documentTools": {
    "access": "write",
    "reviewers": ["<principalId>"],
    "finalApproverId": "<principalId>",
    "maxNewPerRun": 5,
    "plans": ["<plannerAgentId>"]
  }
}
```

- `access`: `read` offers the read tools only and caps the agent at read on every
  document; `write` also offers the write tools.
- `reviewers`: 1 to 50 people; the default is the agent's owner. Each must be
  able to read the agent. A document the agent submits goes to them. On
  `create_agent` only the owner can be a reviewer; share the agent and then add
  other reviewers with `update_agent`.
- `finalApproverId`: optional; the person who may force an approval.
- `maxNewPerRun`: 1 to 20 new documents per run; the default is 5.
- `plans`: up to 20 planner agents (agents with `planDocument`) whose plan
  documents this agent may read and comment on. You need `execute` on each.

`documentTools: null` turns it off. The setting is read again on every call, so
turning it off or lowering `access` takes effect between calls of a running
agent.

`documentTools` is owner-only, like the agent's secrets and tools: it counts as
an owner binding. An agent that everyone can write cannot have it, and an agent
that has it cannot be opened to everyone with write. `make_owner` between two
owners turns it off (`documentToolsCleared` in the result), for the new owner
to set again. It also removes the document grants other people gave the agent,
except on documents the new owner owns (`documentGrantsRemoved`), so the new
owner cannot reach documents that were shared with the previous owner's agent.
Adopting an agent that had no owner keeps both the setting and its grants.

### Upgrading: tool names starting with `doc_`

Names starting with `doc_` are reserved for these tools. `create_tool` and
`wardby tool create` refuse a new tool with such a name, an import skips one
with a warning, and `attach_mcp_server` refuses a server whose exposed tool
names start with `doc_`. A tool created under such a name before the upgrade
keeps working and can still be attached. But if its name is one of the nine
built-in names below and the agent has `documentTools`, every call to that
name goes to the built-in document tool and your tool is never reached. Before
turning `documentTools` on, create the tool again under another name, attach
it, and detach the old one.

## The tools

| Tool                    | Needs   | What it does                                                                                                 |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `doc_list`              | read    | The documents and designs the agent can reach, with access, review state and latest version (`limit` 1-100). |
| `doc_get`               | read    | One document or design: content (Markdown, or files by path), review state and reviewers' verdicts.          |
| `doc_list_threads`      | read    | A document's comment threads (`open`, `resolved` or `all`).                                                  |
| `doc_get_thread`        | read    | One thread with all its comments.                                                                            |
| `doc_create`            | write   | A new document or design linked to the agent, first version, in draft.                                       |
| `doc_publish_version`   | write   | A new version of a document the agent can write. Needs `baseNumber`.                                         |
| `doc_reply_to_thread`   | comment | A reply to a thread on a document the agent can comment on.                                                  |
| `doc_resolve_thread`    | write   | Marks a thread resolved.                                                                                     |
| `doc_submit_for_review` | write   | Submits a document the agent can write to the setting's reviewers.                                           |

Document and comment text reaches the model as untrusted data, never as
instructions.

## Which documents the agent can touch

An agent never gets its owner's access. Only these give it any:

- **Linked writer**: a document linked to the agent as its writer
  (`create_document` by the agent itself, or `link_document` with `agentId`
  alone) is writable by it. Link a native agent that has `documentTools` with
  `write`, and that you can execute. The link counts only while the document's
  owner can still execute the agent.
- **Grants**: `grant_access` with `grantee: {"agentId": "<id>"}` on a document
  gives the agent `read` or `comment`. You must own the document and be able to
  read the agent. `write` is refused with
  [`document_agent_grant_level`](errors/document-agent-grant-level.md); use
  `link_document` to make an agent the writer. Revoking by `agentId` always
  works.
- **`plans`**: the plan documents of the planners named in the setting, at
  comment, while the agent's owner can still execute each planner. The agent
  never publishes to a plan document.

`access: "read"` caps all of this at read. A document the agent cannot read is
answered as `document_not_found`.

## What an agent never does

An agent does not approve, force-approve, reopen, archive, share or grant
access, and does not start comment threads: it replies to and resolves existing
ones. Submitting for review sends the document to the setting's reviewers, not
to anyone the agent picks, and only for a document the agent's owner owns: on a
document someone else linked to it, `doc_submit_for_review` is refused with
[`document_review_forbidden`](errors/document-review-forbidden.md). The
documents an agent creates belong to its owner; an agent with no owner cannot
use the write tools (`document_agent_unavailable`).

## Limits and errors

- `doc_get` refuses a document or design over 60,000 characters with
  [`document_too_large_for_agent`](errors/document-too-large-for-agent.md), the
  same cap as send to agent. Read it in smaller pieces by splitting the document.
- `doc_create` stops after `maxNewPerRun` documents in a run with
  [`document_run_limit`](errors/document-run-limit.md). The count survives a
  resumed run. The usual size limits of [documents](documents.md) apply.
- `doc_publish_version` needs `baseNumber`, the version the agent read. When a
  newer version exists it fails with
  [`document_version_conflict`](errors/document-version-conflict.md); the agent
  reads again and redoes its edit.
- An approved or archived document is locked
  ([`document_locked`](errors/document-locked.md)); a design must be a valid
  board set (`board_format_invalid`).
- `create_agent` and `update_agent` refuse a bad setting with a 400 that
  starts `document_tools_invalid: ` and gives the reason
  ([details](errors/document-tools-invalid.md)).

Tool failures come back as a JSON result with an `error` code, never as a
crash, and logs carry only the tool name and the code.

## Send threads to a native writer

When a document's writer is a native agent, **Send to agent** (or
`send_threads_to_agent`) starts a native run with the trigger `comment`. Its task
names the threads and the document; the agent reads them with the tools,
publishes one revision and replies. Threads the agent leaves unanswered get the
usual no-reply note. There is no automatic merge: the agent publishes through
`baseNumber`, and a document that changed meanwhile conflicts.

A send is refused with
[`document_not_agent_linked`](errors/document-not-agent-linked.md) when the
agent no longer has `documentTools`, and with
[`document_agent_unavailable`](errors/document-agent-unavailable.md) when its
setting is no longer `write` or the document's owner lost `execute` on it.

## Related

[Documents](documents.md) · [Plan documents](plan-documents.md) · [Review and approve documents](document-review.md) · [Use native agents, tools, and data](native-capabilities.md) · [Send comment threads to a coding agent](comment-threads-and-agents.md)
