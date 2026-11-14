---
id: errors/document-review-forbidden
title: Review action not allowed (document_review_forbidden)
summary: Only named reviewers give verdicts, and only the owner or the final approver force approves.
audience: operator
tags: [error, documents, review, document_review_forbidden]
appliesTo: ">=0.10.0"
---

# Review action not allowed

`document_review_forbidden` (HTTP 403). The caller is not allowed this review action: a verdict from someone who is not on the reviewer list, or a force approval from someone who is neither the owner nor the final approver (guests never force approve).

Ask the owner to add you as a reviewer (`submit_for_review` replaces the list while the document is in review) or to name you final approver.

See [Review and approve documents](../document-review.md).
