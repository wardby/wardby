---
id: errors/document-reject-not-plan-document
title: Only a document of a plan or an option set can be rejected (document_reject_not_plan_document)
summary: Reject applies to documents of a plan set other than plan.md, and to documents of an option set; a document in no set, plan.md itself, or a document already out of its set is refused.
audience: operator
tags: [error, documents, review, plans, option sets, reject, reject_document, document_reject_not_plan_document]
appliesTo: ">=0.10.0"
---

# Only a document of a plan or an option set can be rejected

`document_reject_not_plan_document` (HTTP 409). Reject (`reject_document`, or **Reject** in the Review tab) takes a document out of its set, so it applies only to a document that belongs to a plan or to an option set (made with `doc_create` `set` and `option`) and is still part of it. It is refused for:

- a document in no set: request changes or archive it instead;
- a plan's own `plan.md`: the plan cannot exist without it, so request changes on it instead;
- a document already out of its set (rejected, or removed by a planner run).

To bring a rejected document back into its set, reopen it for review (`reopen_document`).

## Related

- [Review and approve documents](../document-review.md#reject)
- [Plan documents](../plan-documents.md)
