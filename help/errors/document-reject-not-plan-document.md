---
id: errors/document-reject-not-plan-document
title: Only a plan document can be rejected (document_reject_not_plan_document)
summary: Reject applies to documents of a plan set other than plan.md; a document outside a plan, plan.md itself, or a document already out of the plan is refused.
audience: operator
tags: [error, documents, review, plans, reject, reject_document, document_reject_not_plan_document]
appliesTo: ">=0.10.0"
---

# Only a plan document can be rejected

`document_reject_not_plan_document` (HTTP 409). Reject (`reject_document`, or **Reject** in the Review tab) takes a document out of its plan, so it applies only to a document that belongs to a plan and is still part of it. It is refused for:

- a document that is not part of a plan: request changes or archive it instead;
- a plan's own `plan.md`: the plan cannot exist without it, so request changes on it instead;
- a document already out of the plan (rejected, or removed by a planner run).

To bring a rejected document back into its plan, reopen it for review (`reopen_document`).

## Related

- [Review and approve documents](../document-review.md#reject)
- [Plan documents](../plan-documents.md)
