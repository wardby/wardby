---
id: plan-documents
title: Plan documents (planner and builder coding agents)
summary: A coding agent with planDocument publishes its plan as Wardby documents for review; a builder with buildFromPlan builds only from an approved plan, ticket by ticket, started by the approval or by a build ticket comment.
audience: operator
tags: [plans, planDocument, buildFromPlan, onApproved, build ticket, plan_approved, plan_not_approved]
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

`create_agent` and `update_agent` check the setting when it is saved, and refuse
it with:

- `plan_reviewer_invalid`: a reviewer or the final approver does not exist, or
  can't read the agent.
- `plan_builder_invalid`: the builder is not a coding agent with
  `buildFromPlan`; the planner's owner can't execute the builder or give it a
  task; or the builder's owner can't execute the planner.
- `plan_settings_invalid`: the setting could not be checked.

With `create_agent` the agent is new, so nobody else has access to it yet: only
you (its owner) can be a reviewer or the final approver, and the builder must be
one you own. Add other reviewers, or a builder someone else owns, with
`update_agent` after you share the planner with them.

## The plan number

The plan number is the issue number when the run came from an issue or a comment
on it. A lead that delegates with no issue passes `planNumber` on the delegate
call. With neither, the run is refused with `plan_number_missing`. A plan is
unique per planner agent, repository and number.

## The plan folder and its layout

A planner writes its plan to `/tmp/wardby-plan` in its workspace (store
`wardby`), or to the `path` folder in the repository (store `repository`).

- One document per top-level `*.md` file; `plan.md` comes first. A document's
  title is its first heading, or its file name when it has none.
- One design per subfolder in the [board format](design-boards-format.md); a
  design's title is its folder name.
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
threads to the agent
([Comment threads and agents](comment-threads-and-agents.md)) starts the plan's
own planner with the current version of every document still in the plan (not
removed) in the plan folder. Only a document the planner changed, and nobody
edited meanwhile, gets a new version; the others go through the usual reconcile.
A reply to a revision never quotes the plan's text. This applies to a plan
stored in Wardby: a document of a plan stored in the repository, or any other
document linked to a planner, is edited like any linked document (an ordinary
run on its file).

## The plan bar and links

Every document in a set shows "Plan N · X of Y approved" over the documents the
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

A coding agent with `buildFromPlan: true` builds from an approved plan.

### The gate

Each run of the builder that has an issue or a `planNumber` looks up the plan for
its repository and plan number (the issue number, or `planNumber` on a lead's
delegate call). A builder run with neither is not checked against any plan: a
lead that delegates a build with no issue must pass `planNumber`, or the build
is not gated.

- Only a plan whose planner the builder's owner can execute counts. When several
  such plans share the repository and number, the newest one is used. The
  repository name matches exactly, ignoring case.
- No such plan: the run goes ahead as usual, with no plan.
- A document of that plan still not approved (removed documents do not count):
  the run is refused with [`plan_not_approved`](errors/plan-not-approved.md),
  and nothing is started. When the run was asked for on an issue (a GitHub
  mention or a Jira trigger), Wardby replies there with the waiting documents by
  path. That reply is posted even when mention explanations are off.
- The builder has no owner, or its secret values cannot be read: refused with
  `plan_not_approved` too (the plan is never sent unchecked).
- Every document approved: the builder gets the approved Markdown in its request
  and every approved document as files in `/tmp/wardby-plan`, with links between
  them rewritten to those files. The text is redacted against the builder's
  secret values.

A continuation of a build (a fix round, a follow-up on its pull request) builds
from exactly the versions the build was given, so reopening a document never
refuses it.

The builder's pull request body gets a plan line, such as
`Plan 12: plan.md v3, screens v2`.

### When the plan is approved

The approval is the review event that leaves every document of the plan
approved. The planner's `onApproved` decides what happens:

- `notify` (the default): Wardby posts "Plan N approved" on the plan's issue with
  the document versions. On GitHub the notice ends with a hint: comment
  `@<handle> build ticket <t>` to build.
- `build`, with `builderAgentId`: on the plan's first approval, Wardby checks
  the builder again and starts ticket 1, recorded as started by the person whose
  approval completed the plan. The issue gets "Plan N approved", then "building
  ticket 1". When the builder can no longer build it, nothing starts and the
  notice says `plan_builder_invalid`. When `plan.md` has no `## Tickets`
  section, nothing starts and the notice says so.

The builder can no longer build when it is not a coding agent with
`buildFromPlan`, when the planner's owner can no longer execute it or give it a
task, or when the builder's owner can no longer execute the planner.

Reopening a document ends the approval. A later approval fires again.

### Tickets and the chain

`plan.md` lists its tickets in a `## Tickets` section, one
`### Ticket <t>: <title>` heading per ticket, numbered from 1. With `build`, the
tickets run one after another:

- The next ticket starts when the pull request of the chain's ticket run merges.
  It is recorded as started by the approver, and the builder is checked again
  before it starts.
- When a fix round of the merged ticket is still running, the next ticket waits
  for it to end.
- After the last ticket merges, the issue gets "all N tickets built".
- The chain stops, with a notice on the issue naming the ticket and a code, when:
  - the ticket's run ends `failed` (including a run that timed out waiting in
    the queue), `cancelled`, `refused`, `lost` or `budget_exhausted`;
  - the run succeeds without a pull request (`no_pull_request`);
  - its pull request closes unmerged (`pr_closed`);
  - the next ticket does not start: the start fails (`start_failed`), the
    builder can no longer build (`plan_builder_invalid`), or the start is
    refused (its refusal code, such as `plan_not_approved`).
- Reopening a document stops the chain before its next ticket (`reopened`).
  The issue gets "Plan N: a document was reopened; the build stops after ticket
  t." The ticket run already going finishes, but its merge starts nothing.

Only a plan's first approval starts the chain. When a plan whose chain ran
before (stopped, reopened, or finished) is approved again, nothing starts: the
notice names the ticket to build next (on GitHub, as a `build ticket <t>` hint),
and after a finished chain it asks for any ticket. Use `build ticket <t>` to
start again.

On GitHub, the notice for a run or pull request that stopped the chain ends with
a hint to continue with `build ticket <t>`.

### Build a ticket from the issue

On the plan's GitHub issue, comment `@<handle> build ticket <t>`, where
`<handle>` is the GitHub App's name. The commenter needs the same repository
access as any mention that starts a run. The command uses the newest approved
plan for the issue whose planner names a builder, the same plan the builder's
gate would pick.

- With `onApproved: "notify"`, it builds that ticket only. Its merge starts
  nothing.
- With `onApproved: "build"`, it restarts the chain from that ticket, clearing
  any stop.
- When `plan.md` lists tickets, a ticket it does not list is refused ("Plan N
  has no ticket t").
- Only one ticket run of a plan runs at a time, fix rounds included. While one
  runs, the reply is "already building ticket t" and nothing starts.
- The builder is checked again every time (`plan_builder_invalid`).

Jira has no `build ticket` command, and notices on a Jira issue carry no hint. A
Jira plan with `onApproved: "build"` still runs its chain, and its notices are
posted through a write-access issue-project link.

### The run trigger

A run started by an approval or by the chain has the trigger `plan_approved`
("plan approved" in the viewer). A run started by `build ticket <t>` has the
trigger `comment`.

## Images and upgrades

- Planner, revision and builder runs (any run that writes or gets plan files)
  need a Codex worker image built on `driver-v37` or later; a Claude Code
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

The build chain's stop codes, shown in its notices on the issue (not error
codes): `failed`, `cancelled`, `refused`, `lost`, `budget_exhausted`,
`no_pull_request`, `pr_closed`, `reopened`, `start_failed` and
`plan_builder_invalid`, or the refusal code of a ticket start that was refused.

## Related

[Documents](documents.md) · [Review and approve documents](document-review.md) · [Builder agent](builder-agent.md) · [Agent recipes](agent-recipes.md)
