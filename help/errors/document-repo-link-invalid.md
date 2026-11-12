---
id: errors/document-repo-link-invalid
title: Repository link invalid (document_repo_link_invalid)
summary: create_document got an incomplete or unusable repository link.
audience: operator
tags: [error, documents, document_repo_link_invalid]
appliesTo: ">=0.10.0"
---

# Repository link invalid

`document_repo_link_invalid` (HTTP 400). `create_document` refused the repository link. It needs `repository`, `path` and `agentId` together; the agent must be a coding agent you can execute. `repository` is `owner/name` or, for a local repository, `local:/abs/path` inside the trusted folders (see [Local repositories](../local-repositories.md)).

See [Documents](../documents.md).
