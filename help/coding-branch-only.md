---
id: coding-branch-only
title: Push a coding run's branch without opening a pull request
summary: A coding run can push its branch and open no pull request, by answering pullRequest none (or a workflow script returning it); the status comment links the branch and a pre-filled page to open the pull request later.
audience: operator
tags: [branch only, no pull request, pullRequest, branch_pushed, coding-agents, claude-code, codex, workflow]
appliesTo: ">=0.10.2"
---

# Push a coding run's branch without opening a pull request

Some work should be pushed but left for a person to turn into a pull request, for
example a fix an engineer will finish. A coding run can ask for that itself: the
branch is pushed as usual, and no pull request is opened.

## Ask for it

- **Any coding run (Codex or Claude Code):** the run's final answer sets
  `"pullRequest": "none"`. The agent does this when the task says not to open a
  pull request, so say so in the task ("push the branch, don't open a pull
  request").
- **A workflow run:** the script returns `pullRequest: "none"` in its result,
  next to `prTitle` and `prBody`. The script decides, not the session.
- **Several repositories:** each one chooses. The top-level `pullRequest` is the
  default repository's; each entry of the answer's `pullRequests` can carry its
  own `pullRequest: "none"`.

Any other value, or none, opens the pull request as usual. Asking for no pull
request can only make a run do less, so it needs no extra permission.

## What happens

- The run's result is `branch_pushed`, with the branch name. On GitHub it also has
  `branchUrl` and `compareUrl`: a page that opens a pull request from the branch,
  with the run's title and, when it fits in the link, its description filled in.
- A status comment on a GitHub issue or a Jira ticket carries the run's reply, then
  "Pushed branch `wardby/…`" with the links. Jira moves on pull request opened or
  merged don't happen, because there is no pull request.
- Reviewer triggers, review fix rounds and mark-ready don't run either; they do once
  a pull request is opened from the branch. A branch-only repository has no pull
  request in a run's merge order.

## Open the pull request later

- **By hand:** follow the status comment's link (or the result's `compareUrl`).
- **With a later run:** continue the run (`continuePriorRun`). It works on the same
  branch, and if it doesn't ask for branch only, it opens the pull request.

## Related

- [Coding branch names](coding-branch-names.md)
- [Pull request titles](pull-request-titles.md)
- [Run a Claude Code workflow script](coding-workflows.md)
