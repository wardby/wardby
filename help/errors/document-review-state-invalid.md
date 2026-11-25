---
id: errors/document-review-state-invalid
title: Review action does not fit the state (document_review_state_invalid)
summary: The review action does not fit the document's current review state or its input, such as a verdict on a draft or a submit with no reviewers.
audience: operator
tags: [error, documents, review, document_review_state_invalid]
appliesTo: ">=0.10.0"
---

# Review action does not fit the state

`document_review_state_invalid` (HTTP 409). Examples:

- a verdict on a draft or an archived document;
- submitting with no reviewers, more than 50, an unknown person, or a guest who is not on one of this document's live comment share links;
- changing the reviewer list of an approved, rejected or archived document (reopen or unarchive it first);
- force approving a draft, an approved or an archived document, or without a note;
- a reviewer's verdict on a document the owner or final approver force approved (a force approval is final; a writer reopens it for review);
- reopening a document that is not approved or rejected;
- archiving an archived document, or unarchiving one that is not archived.

Read the current state with `get_document` (or reload the page) and try the action that fits it.

See [Review and approve documents](../document-review.md).
