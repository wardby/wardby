---
id: document-review
title: Review and approve documents and designs - states, reviewers, force approve, lock and wait_for_review
summary: Submit a document or design for review by named people or comment-link guests, collect approvals, force approve with a note, lock approved versions, and make an agent session wait for approval.
audience: operator
tags:
  [
    documents,
    designs,
    review,
    approve,
    reviewers,
    add reviewers,
    start review,
    comment link,
    submit_for_review,
    review_document,
    wait_for_review,
    force approve,
  ]
appliesTo: ">=0.10.0"
---

# Review and approve documents

A whole [document](documents.md) or [design](designs.md) has a review state. Comment threads keep their own states (open, resolved, outdated; open and outdated threads take replies); the review state is about the document as a whole.

## States

| State             | Meaning                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Draft             | New and existing documents. Not in review.                                                      |
| In review         | Submitted; waiting for the reviewers' verdicts on the current version.                          |
| Changes requested | A reviewer requested changes on the current version.                                            |
| Approved          | Every reviewer approved the current version, or the owner or final approver forced it. Locked.  |
| Rejected          | A document of a plan that was turned down (see [Reject](#reject)). Locked, and out of the plan. |
| Archived          | Set aside by the owner. Locked. Unarchive returns it to the state it had before.                |

Only verdicts on the **current version** count, so publishing a new version while the document is in review or has changes requested recomputes the state: earlier verdicts show as "on an older version" and nobody has approved yet (changes requested on v3 becomes in review on v4).

## Roles

- **Reviewers**: the people the owner names: members with access to the document, or guests of this document's comment share links who gave a name. Naming a member gives them comment access if they lack it. The owner is a reviewer only if listed.
- **Owner**: submits, changes the reviewer list, names the final approver, archives, and can always force approve.
- **Final approver** (optional, one person): can force approve; gives verdicts only if also listed as a reviewer.
- **Writers** (write access) reopen an approved document for review: that creates a new version, a copy of the approved one, and puts it in review. Anyone else, a guest included, is told in the Review tab to ask someone who can edit it.

Reviewers act only with live access: a member needs at least comment access, and a guest needs a comment share link that is not revoked or expired. A reviewer who loses access cannot act; they stay listed until the owner removes them, and a force approval covers them.

## Approving

A reviewer approves or requests changes on the version they read, with an optional note. If a newer version was published meanwhile, the verdict is refused (`document_version_conflict`): read the new version and review it. The page shows "vN was published while you were reviewing vM" and a **Review vN** button that shows what changed since vM (on a design, vN opens in History with the boards changed since vM marked "changed").

A reviewer is offered only the verdict they have not already given on the current version. With no verdict yet, they see **Approve** and **Request changes**. After approving, they see "You approved vN" and only **Request changes**; after requesting changes, "You requested changes on vN" and only **Approve**. Giving the same verdict again (for example `review_document` with `approve` twice) changes nothing: no event is recorded and a new note sent with it is not stored. After a reopen, reviewers give their verdict again on the new version.

A named reviewer can also request changes on a document every reviewer approved: the Review tab offers only **Request changes on vN** (no Approve). It moves the document to Changes requested and unlocks it, so a new version can be published. A force approval is final: reviewers are offered no verdict on it, `review_document` is refused with `document_review_state_invalid`, and a writer reopens the document for review.

**Force approve**: while the document is in review or has changes requested, the owner or the final approver approves the current version over missing verdicts and requested changes. A note is required, and the history records who was overridden.

## Reject

A document of a [plan](plan-documents.md) can be **rejected** instead of approved, for example a design option nobody chose. The owner, the final approver or a named member reviewer chooses **Reject** in the Review tab (or calls `reject_document`) and gives a note, such as "Option B was chosen". The document becomes Rejected:

- It is read-only, like an approved document. Comments stay open.
- It leaves the plan: it no longer counts toward the plan's approval, and a builder never gets it. The plan bar still lists it, struck through, as "Rejected".
- Rejecting the last document the plan was waiting for approves the plan, the same as an approval does (with `onApproved: "build"`, ticket 1 starts).
- A later planner run does not change it or bring it back.

A writer reopens a rejected document for review to bring it back into the plan: like reopening an approved one, it starts a new version and every reviewer gives their verdict again. A plan's own `plan.md`, and a document that is not part of a plan, cannot be rejected ([`document_reject_not_plan_document`](errors/document-reject-not-plan-document.md)).

## The lock

An approved, rejected or archived document takes no new version by any route: the editor, board saves, `publish_version`, restore, and agent edits are refused with [`document_locked`](errors/document-locked.md), and threads cannot be sent to the agent. Comments stay open in every state.

A document or design page that is open when the document is approved or archived becomes read-only in place, with no reload; comments still work. To change an approved document, a writer **reopens** it: Reopen for review creates a new version (a copy of the approved one) and puts it in review, with every reviewer waiting again; the approved version stays in History as the approved record. The writer then publishes changes and the reviewers approve again. Open pages move to the new version. Edits not yet saved when the lock lands are kept: while locked the page says so ("Read only: approved · unsaved changes"), and after a reopen they show as "Unsaved changes" and are saved with your next edit, never on a timer. A Markdown page becomes editable again in place; a design page that was opened read-only must be reloaded to edit it. An agent edit that finishes after approval is not applied; its threads get a reply naming the branch that holds it.

## The page and the Viewer

Every document and design page shows a banner with the state and the approval count (for example "In review · v4 · 1 of 3 approved") and a **Review** tab with the reviewers, their verdicts, the history, and the actions you may take: Start review, Edit reviewers, Approve, Request changes, Force approve, Reopen for review, Archive, Unarchive. The Documents tab of the desktop Viewer lists each document's state as a chip.

### Choose the reviewers on the page

**Start review** (on a draft) and **Edit reviewers** (in review or changes requested) open the same picker:

- It lists the members with access to this document and the guests of its live comment links who gave a name ("(guest)"). Type in **Find people** to filter by name.
- For someone without access, **Create comment link** makes a comment share link (default expiry). It is shown once: copy it and send it. After they open it and give a name, **Refresh list** lists them.
- **Submit for review** (or **Save reviewers**) confirms the list; you may also pick a final approver.

## MCP tools

| Tool                     | Who                                              | Does                                                                                                                                                                |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submit_for_review`      | owner                                            | `reviewers` (principal ids and/or `guest:<id>`, 1 to 50), optional `finalApproverId`; draft to in review, or replaces the list while in review or changes requested |
| `review_document`        | a named reviewer                                 | `verdict` `approve` or `request_changes`, `versionNumber` (required), optional `note`                                                                               |
| `force_approve_document` | owner or final approver                          | `note` required; the result lists `overridden`                                                                                                                      |
| `reject_document`        | owner, final approver or a named member reviewer | a plan document (never `plan.md`) to rejected and out of the plan; `note` required                                                                                  |
| `reopen_document`        | writers                                          | approved or rejected to in review on a new version, a copy of the current one; `currentVersion` in the result is the new version's number                           |
| `archive_document`       | owner                                            | `archived: true` or `false`                                                                                                                                         |
| `wait_for_review`        | `documents:read`                                 | waits until the state differs from `state`, someone else comments, or `timeoutSeconds` (default 300, at most 600) passes; returns `changed` and `reason`            |

`get_document` and `list_documents` include `reviewState`; `get_document` also returns the reviewers, the final approver and the last 20 review events. Only the owner gets the ids of people: each reviewer's `ref`, each event's `actorRef`, `finalApproverId`, and `reviewCandidates` (the people and guests that can be named); everyone else gets names and verdicts. Names and review notes come back only in `reviewText`, wrapped as untrusted tool output. Review notes are stored with the linked agent's secret values redacted.

## Make an agent session wait for approval

1. `create_document` with the plan.
2. `submit_for_review` with the reviewers.
3. `create_share_link` (comment) if reviewers have no account, and send them the link; once they have opened it and given a name, they appear in `reviewCandidates`.
4. `wait_for_review` with the state you saw (`in_review`). It returns `changed` (whether the state differs) and `reason`: `state` (the review state changed), `comment` (someone other than you started a thread or replied, including an agent's reply) or `timeout`. On `comment`, read the threads with `list_comment_threads`, reply, and wait again with the same state; on `timeout`, call it again. Many MCP clients give up on a request after 60 seconds, so pass `timeoutSeconds` of 50 or less and loop while `changed` is `false`.
5. On `changes_requested`: read the notes (`get_document`) and threads (`list_comment_threads`), revise with `publish_version`, reply to or resolve the threads, and wait again.
6. On `approved`: continue, citing the approved version number.

## Errors

- [`document_locked`](errors/document-locked.md) (409): approved, rejected or archived.
- [`document_reject_not_plan_document`](errors/document-reject-not-plan-document.md) (409): Reject on `plan.md`, or on a document that is not part of a plan.
- [`document_review_forbidden`](errors/document-review-forbidden.md) (403): not a reviewer, not the owner or final approver, or a reopen without write access.
- [`document_review_state_invalid`](errors/document-review-state-invalid.md) (409): the action does not fit the current state or its input.
- [`document_version_conflict`](errors/document-version-conflict.md) (409): a newer version was published before the verdict.

## Related

[Documents](documents.md) · [Designs](designs.md) · [Share links](document-share-links.md) · [Comment threads and agents](comment-threads-and-agents.md) · [Plan documents](plan-documents.md)
