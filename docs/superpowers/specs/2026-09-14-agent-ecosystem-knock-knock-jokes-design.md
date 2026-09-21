# AI Agent Ecosystem on knock-knock-jokes — Mapping Design

**Date:** 2026-09-14
**Status:** Proposed (mapping/roadmap doc — not an implementation plan)
**Author:** wardby maintainer
**Source vision:** `/Users/chfields/Documents/ai-agent-ecosystem-v2.html` — a
six-capability pitch deck (Delivery Pipeline, Architecture Review, Security
Maintenance, QA End to End, System Monitoring, Project Tracking) with one
rule running through all of it: nothing merges or ships without a human
approving it.
**Target repo:** `chfields/knock-knock-jokes` — a small Python CLI package,
already delivered end-to-end by wardby's Delivery Pipeline (issues #12,
#15, #17, #20, #25). Planned to grow a Vercel deployment.
**Related:** `docs/architecture-runtime.md` (live Delivery Pipeline runtime
topology), `src/core/runner.subagent-dispatch.test.ts` (dispatcher/plan/implement
sub-agent pattern), `docs/private/2026-09-14-roadmap-status-table.md`
(wardby engine build status this design assumes).

> **Clean-room note.** This design is grounded in reading wardby's own
> docs/tests (`architecture-runtime.md`, `runner.subagent-dispatch.test.ts`,
> the roadmap status table) plus the user-supplied vision deck. It copies no
> external codebase.

---

## Goal

The vision deck describes six agent capabilities as a unified pitch. In
reality they are six largely independent subsystems that share one engine
(wardby) and one rule (human approves everything that ships). This
document maps each of the six onto wardby's actual primitives, states
what already exists vs. what's net-new, and gives a build order — so future
work on any one capability starts from an accurate picture instead of
re-deriving it.

This is **not** an implementation plan. Each capability below, once its
turn comes, gets its own brainstorm → spec → plan cycle via the normal
superpowers workflow.

## Non-goals

- Building anything in this pass. This is the mapping/roadmap artifact only.
- Redesigning wardby's core engine. Every mapping below reuses existing
  primitives (scheduler, webhook triggers, sub-agent dispatch, coding-worker
  sandbox, `continuePriorRun` revision-in-place); none requires new engine
  work.
- A multi-team, multi-repo Project Tracking model. knock-knock-jokes is a
  single repo with a single owner — "epics" map to GitHub Milestones,
  "teams" collapses to one.
- System Monitoring's real implementation. It is sequenced last and blocked
  on the Vercel deployment landing; this doc only names the mapping.

---

## 1. Current state (what's already live)

The Delivery Pipeline runs today against knock-knock-jokes
(`docs/architecture-runtime.md`):

```
Issue labeled 'ai-plan' (or @knock-knock-delivery comment)
  -> GitHub Actions (wardby-delivery-trigger.yml)
  -> webhook -> wardby mcp
  -> knock-knock-delivery (dispatcher agent)
       -> knock-knock-plan (sub-agent, kind: coding) -> posts a plan
       -> knock-knock-implement (sub-agent, kind: coding, via continuePriorRun)
          -> implements on the same branch/PR (revision-in-place)
  -> draft PR opened on GitHub
```

Issues #12, #15, #17, #20, #25 were built this way. The sandboxed
coding-worker, credential-injecting proxy, budget metering, and local
Prometheus/Grafana observability (`wardby-knock-knock` dashboard) all already
run for this repo.

**What's missing from this loop, relative to the deck's Delivery Pipeline
page:**

- No automated PR-review sub-agent (the deck's "PR Reviewer: AI review +
  Opus code reviewer sub-agent"). Today a human reviews the draft PR
  directly on GitHub with no AI pre-review pass.
- No explicit "Architect reviews the plan" gate distinct from "Architect
  reviews the PR" — today the plan is posted as a PR/issue comment and a
  human's approval comment or label is what should trigger
  `knock-knock-implement`'s `continuePriorRun` step, but this gate isn't
  formalized (see §3).
- No release automation (CI/CD build → staged rollout → health gate →
  auto-rollback). There's nothing to roll out yet — no deployment target.

---

## 2. Per-capability mapping

| Deck capability          | wardby mapping                                                                                                                                                                | Status                                                                                         | Sequencing                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Delivery Pipeline**    | `knock-knock-delivery` dispatcher + `knock-knock-plan`/`knock-knock-implement` sub-agents, GitHub webhook trigger                                                             | Live; two gaps (PR-review sub-agent, explicit plan-approval gate)                              | 1 — close gaps first, everything else builds on this pattern |
| **Architecture Review**  | New weekly-cron agent (`kind: coding`), read-only repo scan, opens a GitHub issue or PR comment with the report — no PR of its own                                            | Net-new, no engine blockers                                                                    | 2                                                            |
| **Security Maintenance** | New Thursday-cron agent: runs `pip-audit`/`safety` in the sandbox, patches only safe version bumps, opens a PR; stops silently if nothing's safe to fix                       | Net-new, no engine blockers                                                                    | 2                                                            |
| **QA End to End**        | Two sub-agents mirroring the Delivery Pipeline split: a "map coverage" agent (weekly, read-only) hands off to a "write tests" agent (opens a PR, a couple of tests at a time) | Net-new, no engine blockers                                                                    | 2                                                            |
| **Project Tracking**     | Read-only agent querying GitHub Issues/Milestones/PRs (via MCP-authored tools or the GitHub API directly), posts a status summary                                             | Net-new, no engine blockers, but lowest standalone value on a single-repo/single-owner project | 3                                                            |
| **System Monitoring**    | Watches the Vercel deployment's logs/errors once it exists, opens a defect issue that feeds back into Delivery Pipeline as a new `ai-plan`-labeled issue                      | Blocked on the Vercel deployment landing                                                       | 4                                                            |

Architecture Review, Security Maintenance, and QA End to End are
independent of each other and of Project Tracking — they can be built in
any order or in parallel once Delivery Pipeline's gaps are closed, since
each is "scheduled cron + read repo (+ write PR)" using infrastructure that
already exists for Delivery Pipeline.

## 3. Human-approval gates → real mechanics

The deck's recurring "a human approves" step is not a new primitive to
build anywhere — it maps onto mechanics wardby or GitHub already provide:

- **Plan approval** (Delivery Pipeline, page 2 "Architect reviews the
  plan"): a human's approval comment or label on the issue/PR the plan-run
  posted to is what should trigger the dispatcher's `delegate_to_implement`
  call with `continuePriorRun` set to the plan run's id — the mechanism
  (`continuePriorRun` threading through `dispatchRun` to the same
  `CodingRun`/branch/PR) already exists and is tested
  (`runner.subagent-dispatch.test.ts`); what's missing is the trigger
  wiring from "human comments approve" to "dispatcher re-fires."
- **PR approval** (Delivery Pipeline, Security Maintenance, QA End to End):
  literally merging the GitHub PR. Nothing to build — this is already how
  knock-knock-jokes works today.
- **Defect approval** (System Monitoring): a human confirms the
  auto-opened defect issue is real and labels it `ai-plan`, which is the
  same trigger Delivery Pipeline already listens for — System Monitoring's
  only job is to open a well-formed issue; the loop that turns it into code
  is Delivery Pipeline, unchanged.

No capability in this ecosystem needs a bespoke approval workflow beyond
"comment/label on GitHub" — this is a deliberate simplification versus the
deck's more abstract "Architect" role, chosen because knock-knock-jokes has
no separate work-tracking tool.

## 4. Build order

1. **Close Delivery Pipeline's two gaps** — PR-review sub-agent (Opus-backed
   read-only review pass before a human sees the PR), explicit plan-approval
   trigger wiring. Highest leverage: every later capability that opens a PR
   (Security Maintenance, QA End to End) benefits from the same review
   sub-agent once it exists.
2. **Architecture Review, Security Maintenance, QA End to End** — buildable
   in parallel, each its own brainstorm → spec → plan cycle. No ordering
   dependency between them.
3. **Project Tracking** — lowest priority; a single-repo status summary has
   limited value until there's more than one epic/milestone worth tracking.
4. **System Monitoring** — blocked until the Vercel deployment exists;
   revisit sequencing once that lands.

---

## 5. Open questions for future spec cycles

- What triggers the plan-approval comment check — a second GitHub Actions
  workflow (`pull_request_review_comment`), or a webhook wardby already
  receives that needs a new handler branch? (Deferred to the Delivery
  Pipeline gap-closing spec.)
- Should the PR-review sub-agent block the human's own review, or run
  advisory-only (comment, never a required check)? Given the deck's
  "nothing auto-merges" rule, it should stay advisory — no CI gate blocks
  merge on the AI reviewer's verdict.
- Security Maintenance's "safe fix" definition (patch-level bump only? any
  bump with passing tests?) needs pinning down in its own spec — the deck
  says "never a change that could break the app," which needs a concrete
  test-suite-green criterion.
