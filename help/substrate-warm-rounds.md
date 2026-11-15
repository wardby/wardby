---
id: substrate-warm-rounds
title: Warm rounds on Substrate (resume a round)
summary: SUBSTRATE_WARM_ROUNDS keeps a succeeded coding round's Substrate actors suspended so the next round (continuePriorRun, a lead follow-up, a review fix round) resumes its workspace and Claude session; settings, step lines, eviction and storage cost.
audience: operator
tags: [substrate, warm rounds, resume round, continuePriorRun, SuspendActor]
appliesTo: ">=0.9.15"
---

# Warm rounds on Substrate

On the [Substrate launcher](job-launcher-substrate.md), every round of a coding
run normally starts new actors and a new workspace. With warm rounds on, a
finished round's actors are suspended and kept, and the next round of the same
chain (`trigger_agent` with `continuePriorRun`, a lead's follow-up, or a review
fix round) resumes them. The workspace, including installed packages, and the
Claude session are still there, so a follow-up skips the checkout and install.
See [Continue a coding run](continue-coding-run.md).

## Turn it on

- Set `SUBSTRATE_WARM_ROUNDS=true` on **both** the control plane and the coding
  proxy, with the same value. With it on only for the control plane, a
  follow-up round waits and then fails with the startup timeout
  (`substrate_startup_timeout`). With it on only for the proxy, rounds simply
  start fresh.
- `SUBSTRATE_PARK_TTL_SEC` (control plane): how long a kept round waits for its
  next round, 60 to 86400 seconds, default 3600.
- `SUBSTRATE_PARK_MAX` (control plane): how many rounds may be kept at once, 0
  to 1000, default 10. `0` keeps none: every round starts fresh.
- Give the Substrate ServiceAccount permission for `SuspendActor`.
- The actor templates change name when warm rounds are on, so the first run
  afterwards rebuilds the golden snapshots.

Every detail is in the [Substrate backend guide](../docs/substrate-backend.md#warm-rounds).

## When a round is kept

Only a Claude Code round that succeeded, whose push succeeded and pushed
changes (a round with no changes is not kept), and whose session was cancelled (its credentials revoked) is kept. Any other round is removed, as
without warm rounds.

Rounds with git history always start fresh: a round of an agent with
`codingProfile.gitHistory` set is never kept, and a continuation of one
never resumes. See [Git history](git-history.md).

## Did the next round resume?

`get_run` shows `warmStart: true` when a round resumed and `false` when it
started fresh. The run's steps carry one line either way:

- "Resumed the previous round's workspace and session".
- "Started a fresh workspace: " followed by the previous round was not kept; its
  sandbox expired; the branch changed since the previous round; the agent's
  settings changed since the previous round; its sandbox was no longer
  available; or there was no room to resume it.

A round whose branch preparation merged the target branch also starts fresh,
with no step line.

## What is removed

- `stop_run` removes all of that agent's kept rounds.
- `update_agent` removes them when it changes any setting the round was
  launched with (provider, model, prompt, repository, toolchain, images, limits
  or disk). `delete_agent` removes them too.
- A kept round expires after `SUBSTRATE_PARK_TTL_SEC`.
- Turning warm rounds off removes every kept round when the control plane next
  starts.
- Past `SUBSTRATE_PARK_MAX`, the oldest is removed.
- Under capacity pressure kept rounds are removed oldest first, stopping once a
  removal frees no room, never the one being continued.

## What carries over, and what does not

Kept: the workspace and the Claude session. Not kept: background processes (the
tool runner restarts each round) and credentials (each round gets new ones).

## Storage cost

A kept round costs snapshot storage in Substrate until it expires or is
removed; it does not reserve worker capacity. Size the TTL and
`SUBSTRATE_PARK_MAX` against your storage budget. If your deployment counts
suspended actors against worker capacity, kept rounds are removed oldest first
under pressure.

## Troubleshooting

If every continuation starts fresh, check `SuspendActor` permission, that
`SUBSTRATE_PARK_MAX` is above 0, and the reason in the step line. In the proxy
log, `substrate.diagnostics` lines carry a `round` field after the first round.
A continuation of a local repository is still refused with
[no_pushed_branch](errors/no-pushed-branch.md) when no run pushed the branch.
