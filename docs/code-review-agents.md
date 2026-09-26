# Code-review agents (GitHub App)

A native wardby agent can be linked to a repository so it runs as the wardby
GitHub App: reviewing pull requests automatically and responding to
`@<app-slug>` mentions. This is separate from the coding-agent setup in
[coding-agent-setup.md](coding-agent-setup.md), which pushes branches and
opens draft PRs — a review agent only reads a repository and posts comments,
inline suggestions, and a check result.

## What a linked review agent does

Once an agent is linked to a repository with the `pull_request` trigger:

- Every push to a pull request (open, new commits, reopen, ready-for-review)
  starts an **in-progress check** named after the link's `checkName` (e.g.
  "wardby review").
- The agent reads the diff, then publishes its review in one call: **inline
  comments** on the changed lines (a `suggestion` code block in a comment
  becomes a one-click "Commit suggestion" on GitHub), and **one summary
  comment** that is _edited in place_ on every later review of the same PR
  rather than posted again.
- The check completes as `success` (APPROVE), `failure`
  (CHANGES_REQUESTED), or `neutral` (COMMENT).
- Clicking **Re-run** on the check re-requests it and starts a fresh review
  against the PR's current head.
- Commenting `@<app-slug> review` on a pull request (from an owner, member,
  or collaborator) starts a review the same way a push does.
- Any other `@<app-slug> ...` mention — on an issue, a PR conversation, or
  inside an inline review thread — is routed to whichever agent is linked
  with the `mention` trigger instead, as a normal run with the comment as its
  task. The mention is acknowledged with a 👀 reaction once the run has been
  dispatched.

Only comments from the repository's owner, a member, or a collaborator can
trigger a run; other commenters' `@<app-slug>` mentions are ignored.

## Fork pull requests are skipped

A pull request whose head is in a fork never starts a review, on a push or on
`@<app-slug> review` — the host would have to mint a token against the fork
rather than the base repository. Review it manually, or merge the fork's
changes into a branch on the base repository first.

## Registering the GitHub App

Create or reuse a GitHub App (Settings → Developer settings → GitHub Apps)
with:

- **Webhook URL**: `https://<your-host>/hosts/github/events`
- **Webhook secret**: the same value as `GITHUB_APP_WEBHOOK_SECRET` (see
  below) — generate it with `openssl rand -hex 32` or similar; the ingress
  endpoint answers 404 until this is set.
- **Subscribe to events**: Pull request, Issue comment, Pull request review
  comment, Check run.
- **Repository permissions**:
  | Permission    | Access         |
  | ------------- | -------------- |
  | Contents      | Read           |
  | Pull requests | Read and write |
  | Checks        | Read and write |
  | Issues        | Read and write |

If you change these permissions on an App that is already installed, every
installation must explicitly accept the new permission set before the App's
webhooks resume working for it.

A GitHub App has exactly one webhook URL. Register a **separate App** for
local development or a staging environment rather than pointing your
production App's webhook at a dev host.

### `GITHUB_APP_WEBHOOK_SECRET`

Set alongside `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`
(`.env.example`/`.env.local`), and copy it into the App's webhook secret
field. On the GKE deployment, `deploy/gke/seed-secrets.mjs` seeds this into
Secret Manager as `github-app-webhook-secret`: if no value is carried over
from the cluster or `.env.local`, it generates a random one — copy the
generated value into the App's webhook settings after seeding, or the App's
deliveries will fail signature verification.

## Linking an agent to a repository

Use the `link_repository` tool (agents:write) on a native agent. Calling it
again for an already-linked repository replaces that link's `access`,
`triggers`, and `checkName` — omitted fields are cleared, not kept — so
always send the full desired state. Two common shapes:

**A reviewer**, which starts a check on every PR push:

```json
{
  "agentId": "<agent-id>",
  "repository": "owner/name",
  "access": "write",
  "triggers": ["pull_request"],
  "checkName": "wardby review"
}
```

**A responder**, which only answers `@<app-slug>` mentions that are not a
review command:

```json
{
  "agentId": "<agent-id>",
  "repository": "owner/name",
  "access": "write",
  "triggers": ["mention"]
}
```

Only one agent per repository may hold the `mention` trigger, and only one
agent per repository may use a given `checkName`; linking a second agent the
same way returns a 409 conflict. `access: "read"` may be used without event
triggers to let the agent's `repo_*` tools read a repository on demand
without ever being dispatched by a webhook.

## The `repo_*` tools

A linked agent gets these built-in tools automatically — they are not
attached like ordinary tools, and never expose a token, check id, or
internal marker to the model:

- `repo_pr_read` — a pull request's metadata and per-file diff patches.
- `repo_read_file` / `repo_list_files` — read a file or list a directory at
  a ref.
- `repo_publish_review` — publish inline comments, a summary, and (only for
  an agent linked with a `checkName`) the check verdict for one PR head, in
  one call. Without a `checkName` no check is created.
- `repo_comment` — post or reply to a conversation or inline-review comment.

Every call names the `repository` explicitly; it must resolve to one of the
agent's links. Failures are always a JSON result, never a thrown error:

| `error` code              | Meaning                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_arguments_json`  | The tool call's arguments were not valid JSON.                                                                                        |
| `invalid_arguments`       | Arguments failed schema validation (missing/malformed field).                                                                         |
| `repository_not_linked`   | `repository` does not match one of this agent's links, or matches more than one and needs a `host/owner/name` prefix to disambiguate. |
| `write_access_required`   | A write tool (`repo_publish_review`, `repo_comment`) was called on a read-only link.                                                  |
| `host_not_configured`     | No host provider is configured for this link on this deployment.                                                                      |
| `unknown_tool`            | Not a recognized `repo_*` tool name.                                                                                                  |
| `host_not_installed`      | The GitHub App is not installed on this repository.                                                                                   |
| `host_permission_missing` | The App installation is missing a required permission.                                                                                |
| `host_invalid_response`   | The host returned something the client could not parse.                                                                               |
| `host_api_error`          | The request to GitHub failed (body-free: `github_api_error:<status>[:<request-id>]`).                                                 |

`repo_publish_review` also returns `{ "published": false, "reason": "stale_head", ... }` instead of an error when the PR moved to a new head since the review started; the agent should stop rather than retry.

## Branch protection

To require a passing review before merge, add the link's `checkName` (e.g.
"wardby review") as a required status check in the repository's branch
protection rules. GitHub matches required checks by name, so it must be
exactly what was passed to `link_repository`. Also set the required check's
expected source to the wardby GitHub App, so a check of the same name
reported by anything else (another App, or a workflow in the repository)
cannot satisfy it.

The verdict comes from an LLM reading the pull request's own diff — content
the PR's author controls and can use to steer the model. Treat it as one
signal, not the only merge gate: keep a human approval (or another
independent check) required alongside it.

## Accepted gap: a run reaped as lost leaves its check open

A run's in-progress check is only closed (completed `neutral`, "Use Re-run
to try again") when the run reaches a terminal state through its normal
finish path. A run that the executor's reconciler instead reaps directly as
`lost` — e.g. its process died without a heartbeat — does not go through
that path, so its check can be left showing "in progress" indefinitely. This
is a known, accepted gap: click **Re-run** on the check to start a fresh
review; it does not require any other cleanup.
