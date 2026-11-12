---
id: errors/document-repo-link-invalid
title: Repository link invalid (document_repo_link_invalid)
summary: create_document got an incomplete or unusable repository link.
audience: operator
tags: [error, documents, document_repo_link_invalid]
appliesTo: ">=0.10.0"
---

# Repository link invalid

`document_repo_link_invalid` (HTTP 400). `create_document` refused the repository link. It needs `repository`, `path` and `agentId` together; the agent must be a coding agent. `path` is a repository-relative `.md` file made of plain segments (letters, digits, `.`, `_`, `-`; no `..`), at most 256 characters; `baseRef`, if given, must be a valid branch name and needs a repository. A send refuses a stored link that no longer passes these checks with the same code. `repository` is `owner/name` (or `provider:workspace/repo` for another code host) or, for a local repository, `local:/abs/path` inside the trusted folders (see [Local repositories](../local-repositories.md)).

See [Documents](../documents.md).
