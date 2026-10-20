---
id: github-integration
title: Connect GitHub repositories
summary: Authorize repository access and configure Wardby coding or review agents through a scoped GitHub App.
audience: operator
tags: [github, repositories, coding-agents, code-review, WARDBY_GITHUB_ALLOWED_ACCOUNTS]
appliesTo: >=0.2.1
---

# Connect GitHub repositories

Wardby uses a GitHub App installed only on the repositories an agent may use.
Repository access is checked against the agent owner's linked GitHub account,
or an explicitly recorded administrator approval. Coding agents need write
access because they can push a branch and open a draft pull request.

Wardby rechecks access before preparing a coding workspace and again before
pushing. Losing access, unlinking the account, or a failed access check stops
the run without publishing changes. See [Repository-access troubleshooting](troubleshooting/repository-access.md)
for the resulting refusal states.

Workers do not receive the GitHub App private key. A trusted component validates
the changes, pushes a controlled branch, and opens at most one draft pull
request. Wardby does not auto-merge coding-agent output.

To create and install the App, follow [Set up the GitHub App](github-app-setup.md).

Set the App's credentials as `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` on
the wardby server. Without them, a coding run on a GitHub repository fails with
[`vcs_github_not_configured`](errors/vcs-github-not-configured.md).

From Wardby 0.6.0, wardby serves only trusted GitHub accounts through the App:
the App's owner, plus any accounts listed in `WARDBY_GITHUB_ALLOWED_ACCOUNTS`
(comma-separated logins). Other accounts' events are ignored and their
repositories are refused with `github_account_not_allowed` (help article
`errors/github-account-not-allowed`), including existing links and scheduled
runs after an upgrade. wardby removes the App when another account installs it
or changes its repository selection; remove installations that already exist
on other accounts by hand (App settings, **Install App**). After transferring
the App or renaming its owner, list the new owner in the variable or restart
wardby.

No GitHub App is needed for a git repository on the wardby host. See
[Use local git repositories](local-repositories.md).

Read [`docs/coding-agent-setup.md`](../docs/coding-agent-setup.md) for coding
agent setup and [`docs/code-review-agents.md`](../docs/code-review-agents.md)
for pull-request review agents and webhook configuration.
Use [Run GitHub code-review agents](code-review-agents.md) for the operator
overview of checks, mentions, and fork limitations.

## Events and triggers

Link a native agent to a repository with `link_repository`. Each trigger needs
its GitHub App event ticked in the App's event settings; every event is a
separate checkbox.

| Trigger                         | Starts a run when                                                                                                                                                            | App event to subscribe                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `pull_request`                  | A pull request is opened or pushed to; a re-run of the review check; CI finishing after a review that waited for it                                                          | Pull request, Check run (re-runs of the review check), Check suite (CI finishing)      |
| `pull_request` with `waitForCi` | Same, but the review of a pushed head is held until that head's own CI finishes (or 15 minutes pass), and an approve verdict is refused while CI is failing or still running | Same events as `pull_request`                                                          |
| `mention`                       | Someone with write access `@`-mentions the App                                                                                                                               | Issue comment, Issues, Pull request review comment (mentions in inline review threads) |
| `push`                          | A commit lands on the repository's default branch                                                                                                                            | Push                                                                                   |
| `review_fix`                    | Wardby's own review check requests changes on a PR it opened                                                                                                                 | Same events as `pull_request` (it reacts to that check's own verdict, no extra event)  |

The `push` trigger starts a merge-watcher agent; only default-branch pushes
count (tags, other branches, and deletions are ignored). See
[Keep the knowledge bundle current on merge](help://architecture-agent).

The `review_fix` trigger lets Wardby fix its own review's findings
automatically, up to a round cap, on pull requests its own coding runs
opened. See [Automatic review fix rounds](review-fix-rounds.md).

When a mention run finishes without opening a pull request or failing a
sub-run and its reply is longer than about 2,000 characters (for example a
plan), the status comment does not cut the reply short. It says "✅ Finished
without opening a pull request. The full reply follows in the next
comment(s)." (in a review thread: "...follows in this pull request's
conversation."), and the reply is posted in up to four numbered comments
("Reply, part i of n") of about 60,000 characters each, split at headings,
paragraphs or lines. Anything beyond four parts is cut with a note; the full
text stays on the run (`get_run`, `finalText`). `@`-mentions in the reply are
defused. Each part is posted once; if one cannot be posted, the rest are
skipped. Shorter replies, and runs that opened a pull request or had a failed
sub-run, keep the status comment that quotes up to 2,000 characters.

`waitForCi` holds a reviewer's review until that pull request's own CI
finishes, and gates its ability to approve on CI passing. See
[Review after CI (`waitForCi`)](code-review-agents.md#review-after-ci-waitforci).

With Wardby 0.6.0 or later, a `pull_request` reviewer also holds its review, with or without
`waitForCi`, until the pull request's own delegating run finishes, when its
opening coding run was delegated by a lead agent. See [Reviewing a pull
request a delegated run
opened](code-review-agents.md#reviewing-a-pull-request-a-delegated-run-opened).

With Wardby 0.7.0 or later, `markReadyWhenPassing` on the write link of the
agent the event triggers (a builder, or a lead that delegates to a coding
builder) has Wardby mark the draft pull requests it opens here ready for review
on its own, once every Wardby reviewer check and CI on the head are green
and, for a merge-ordered set, the steps it depends on have merged. See [Mark
ready when passing](code-review-agents.md#mark-ready-when-passing).

For Jira Cloud instead of GitHub, see [Run Jira agents](jira.md).
