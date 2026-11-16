---
id: errors/document-repo-link-invalid
title: Repository link invalid (document_repo_link_invalid)
summary: create_document or link_document got an incomplete or unusable repository link.
audience: operator
tags: [error, documents, document_repo_link_invalid]
appliesTo: ">=0.10.0"
---

# Repository link invalid

`document_repo_link_invalid` (HTTP 400). `create_document` or `link_document` refused the repository link. It needs `repository`, `path` and `agentId` together; the agent must be a coding agent, and the repository must be one the agent is already authorized for (its coding repository, or one on its repository list that is linked), so a link never widens what an agent can reach. For a Markdown document, `path` is a repository-relative `.md` file made of plain segments (letters, digits, `.`, `_`, `-`; no `..`), at most 256 characters, and `baseRef` is optional. For a design, `path` is instead the directory holding `manifest.json`: `.` for the repository root, or plain segments with no trailing `/`, at most 256 characters; a design created without `files` is imported from that directory, so it also needs `baseRef`, the branch to import from. `baseRef`, when given, must be a valid branch name and needs a repository. `link_document` always needs `baseRef` for a design, and `unlink: true` takes no other link field. A send refuses a stored link that no longer passes these checks with the same code. `repository` is `owner/name` (or `provider:workspace/repo` for another code host) or, for a local repository, `local:/abs/path` inside the trusted folders (see [Local repositories](../local-repositories.md)).

See [Documents](../documents.md).
