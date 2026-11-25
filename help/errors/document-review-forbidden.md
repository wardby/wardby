---
id: errors/document-review-forbidden
title: Review action not allowed (document_review_forbidden)
summary: Only named reviewers give verdicts, only the owner or the final approver force approves, and only writers reopen.
audience: operator
tags: [error, documents, review, document_review_forbidden]
appliesTo: ">=0.10.0"
---

# Review action not allowed

`document_review_forbidden` (HTTP 403). The caller is not allowed this review action: a verdict from someone who is not on the reviewer list, a force approval from someone who is neither the owner nor the final approver (guests never force approve), a reject from someone who is not the owner, the final approver or a named member reviewer (guests never reject), or a reopen from someone without write access (a share-link guest, or a member who can only read or comment).

Ask the owner to add you as a reviewer (`submit_for_review` replaces the list while the document is in review) or to name you final approver. To change an approved document you can't edit, ask someone with write access to reopen it; the page says so in the Review tab.

See [Review and approve documents](../document-review.md).
