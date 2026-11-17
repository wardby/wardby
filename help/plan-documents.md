---
id: plan-documents
title: Plan documents (planner and builder coding agents)
summary: A coding agent with planDocument publishes its plan as Wardby documents for review; a builder with buildFromPlan builds only from an approved plan.
audience: operator
tags: [plans, planDocument, buildFromPlan, plan_number_missing, plan_too_large, plan_not_approved]
appliesTo: ">=0.10.0"
---

# Plan documents

A coding agent with `codingProfile.planDocument` publishes its plan as a set of
[documents](documents.md) that people review on their pages: comments, send to
agent, approve. A second coding agent with `buildFromPlan` builds only from the
approved versions. By default the plan never touches the repository: no file, no
branch, no pull request.

The long-form guide is [Plan documents](../docs/coding-agent-setup.md#plan-documents).

## Set up a planner

Set it with `update_agent` (or `create_agent`) on a coding agent you own:

```json
{
  "codingProfile": {
    "planDocument": {
      "store": "wardby",
      "reviewers": ["<principalId>"],
      "finalApproverId": "<principalId>",
      "onApproved": "notify"
    }
  }
}
```

- `store`: `wardby` (the default) keeps the plan in Wardby only. `repository`
  also needs `path`, a repository folder that holds `{n}` once (for example
  `docs/plans/issue-{n}/`); the run then opens its usual branch and pull request,
  and Wardby publishes the folder's files from the run's commit.
- `reviewers`: 1 to 50 people; the default is the agent's owner. Each must be
  able to read the agent.
- `finalApproverId`: optional; may force an approval.
- `onApproved`: `notify` (the default) or `build`, with `builderAgentId`. The
  build hand-off is covered below.

`planDocument: null` turns it off.

## The plan number

The plan number is the issue number when the run came from an issue or a comment
on it. A lead that delegates with no issue passes `planNumber` on the delegate
call. With neither, the run is refused with `plan_number_missing`. A plan is
unique per planner agent, repository and number.

## The plan folder and its layout

A planner writes its plan to `/tmp/wardby-plan` in its workspace (store
`wardby`), or to the `path` folder in the repository (store `repository`).

- One document per top-level `*.md` file; `plan.md` comes first and each title is
  the file's first heading.
- One design per subfolder in the [board format](design-boards-format.md).
- Anything else is ignored and listed in the reply.
- `plan.md` may hold a `## Tickets` section with `### Ticket <t>:` headings;
  builds are numbered by them.

A later planner run for the same number versions the files it changed, adds new
files as new documents, and marks a file it removed `removedFromPlan`. Approved
and archived documents are never changed by a run: the reply names them, and a
person reopens one first. A removed document stays listed (read-only to agents,
and no longer counted toward approval); a send to an agent is refused with
[`document_locked`](errors/document-locked.md).

## Limits

At most 20 documents per plan; 200 files, 1 MiB per file and 8 MiB in all in the
plan folder; 60,000 characters per Markdown document; 1 MiB for one design's
files in all. Over a limit, nothing is published
([`plan_too_large`](errors/plan-too-large.md)).

## Review and revisions from comments

Each document is submitted for review to the reviewers and approved on its own
page ([Review and approve documents](document-review.md)). Sending comment
threads to the agent ([Comment threads and agents](comment-threads-and-agents.md))
starts the plan's own planner with every document's current version in the plan
folder. Only a document the planner changed, and nobody edited meanwhile, gets a
new version; the others go through the usual reconcile. A reply to a revision
never quotes the plan's text.

## The plan bar and links

Every document in a set shows "Plan N - X of Y approved" over the documents the
viewer can read, with a chip per document. A share-link guest sees only "Plan N"
and their own document. Relative Markdown links between files of the set open
the other documents or boards. The bar updates live with the other documents'
review events.

A planner run's pull request or issue comment may say "Plan N: being published."
The publish finishes after the run; the links appear in the plan bar and in later
replies.

## Access

The triggered agent's owner, and anyone with any grant on that agent (including
an everyone grant), can read and comment on every document of the plan. This is
live: losing the grant on the agent loses the plan. This route never gives more
than comment; explicit grants and [share links](document-share-links.md) add on
top, and naming someone as reviewer adds no grant. Sharing an agent with
everyone therefore lets every signed-in user read and comment on the plans it
produces.

## Build from a plan

A coding agent with `buildFromPlan: true` builds from an approved plan set. If a
plan exists for the issue and any counted document is not approved, the run is
refused with [`plan_not_approved`](errors/plan-not-approved.md). If no plan
exists, the run goes ahead as usual. The `onApproved` `notify` and `build`
hand-offs are described in the guide.

## Images and upgrades

- A Codex worker needs an image built on `driver-v37` or later; a Claude Code
  `workerImageRef` tool runner must come from the current release. See
  [Build a worker image](build-worker-image.md) and
  [`coding-worker-byo-images.md`](../docs/coding-worker-byo-images.md#plan-documents-need-a-current-driver-and-tool-runner).
- Keep `/tmp` writable in a custom image.
- On Substrate, the bridge images must come from the same release as the coding
  proxy. An older bridge leaves a planner run with no stored plan
  (`plan_files_missing`). See [the Substrate backend](../docs/substrate-backend.md).

## Codes

What a run's plan status can be: `stored`, `plan_too_large`,
`plan_folder_invalid`, `plan_folder_refused` (the repository folder is under
`.git/` or a protected path, or outside the workspace), `plan_files_failed`,
`plan_tool_unavailable`, `plan_files_unsupported`, `plan_files_missing`,
`secrets_changed` and `secrets_unavailable` (plan files are kept out of Wardby
when the run's secrets cannot be checked). The publish step ends as `published`,
`plan_publish_failed` or `plan_publish_busy` (another publish of the same plan
held it too long: send the request again).

- [`plan_number_missing`](errors/plan-number-missing.md)
- [`plan_too_large`](errors/plan-too-large.md)
- [`plan_files_unsupported`](errors/plan-files-unsupported.md)
- [`plan_not_approved`](errors/plan-not-approved.md)

## Related

[Documents](documents.md) · [Review and approve documents](document-review.md) · [Builder agent](builder-agent.md)
