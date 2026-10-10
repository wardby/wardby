---
id: review-fix-rounds
title: Automatic review fix rounds
summary: Let wardby fix its own review's findings on pull requests its coding runs opened, with a round cap.
audience: operator
tags: [github, code-review, review_fix, autofix, fix-round, pull-requests]
appliesTo: ">=0.4.2"
---

# Automatic review fix rounds

Link an agent with the `review_fix` trigger and wardby will try to fix its
own code review's findings automatically, instead of waiting for a human to
ask. Use `link_repository` with `access: "write"`, `triggers` including
`review_fix`, and an optional `reviewFixMaxRounds` (1–10, default 2); only
one agent per repository may hold this trigger.

A round starts when wardby's own review check on a pull request comes back
`CHANGES_REQUESTED` and the pull request is still open, not from a fork,
still at the commit that was reviewed, and was opened by a wardby coding run
of this same deployment. No human comment is involved — it runs on the
`review_fix` link's own authorization. The agent is asked to fix only the
CRITICAL/MAJOR findings and MUST_FIX recommendations and change nothing
else; what it actually changes, and how much budget it uses, is still up to
the agent's own instructions.

The review is passed to the agent as untrusted context — information about
what to fix, never instructions to follow. Only the review's summary and
body reach the agent, not its inline comments, so write your reviewer's
prompt to list every finding in the review body. A review that is wrong
about CI or about a sibling pull request starts a round that changes
nothing; give your reviewer the CI and related-pull-requests step from
[Run GitHub code-review agents](code-review-agents.md#ci-and-sibling-pull-requests).

A round isn't started while an earlier round on the same pull request is
still running. Clicking **Re-run** on the review check isn't counted as a
round itself; if the re-run's review requests changes, that starts a round
like any other review.

Rounds are tracked with labels on the pull request:

- `wardby-autofix-<N>` — one per round, added before that round's run
  starts.
- `wardby-autofix-limit` — added once the cap is reached; wardby posts one
  comment and stops.
- `wardby-autofix-off` — add this by hand to opt a pull request out
  entirely.

To let a capped pull request have more rounds, remove the round labels
together with `wardby-autofix-limit` (a leftover
`wardby-autofix-limit` means there's no comment when the cap is reached
again). A pull request opened by a different wardby
deployment gets one refusal comment and `wardby-autofix-limit` instead of a
round, since this deployment can't continue a branch it has no record of
opening.

A round's run also double-checks with GitHub that the pull request is still
open right before it pushes; one merged or closed in the time the round was
working fails with no push made — see
[Continuation's pull request is no longer open](errors/continuation-closed.md).

If a repository already forwards reviews to a webhook through a
hand-written CI workflow to fix them automatically, turn on `review_fix` and
then remove that workflow and its webhook, so a review doesn't trigger two
fix rounds at once.

See [`docs/code-review-agents.md`](../docs/code-review-agents.md#automatic-review-fix-rounds)
for the full trigger rules, the App's required permissions, and the related
[code-review-agents](code-review-agents.md) article.
